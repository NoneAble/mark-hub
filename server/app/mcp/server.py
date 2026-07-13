"""MCP Streamable HTTP + OAuth Client Credentials (KD-8 / F-016)."""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from typing import Any

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.domain import bookmarks as bm_svc
from app.domain import folders as folder_svc
from app.domain import tags as tag_svc
from app.domain.settings_svc import get_setting
from app.models import User
from app.utils.errors import api_error

router = APIRouter(tags=["mcp"])

# In-process OAuth client-credentials tokens (single-admin MVP)
_oauth_tokens: dict[str, dict[str, Any]] = {}
MCP_CLIENT_ID = "markhub-mcp"
PROTOCOL_VERSION = "2024-11-05"

TOOLS_SPEC = [
    {
        "name": "list_markhub_bookmarks",
        "description": "List bookmarks with optional filters",
        "inputSchema": {
            "type": "object",
            "properties": {
                "folder_id": {"type": "string"},
                "query": {"type": "string"},
                "limit": {"type": "integer"},
            },
        },
    },
    {
        "name": "get_markhub_bookmark",
        "description": "Get bookmark by id",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
    },
    {
        "name": "add_markhub_bookmark",
        "description": "Create bookmark",
        "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}, "url": {"type": "string"}}},
    },
    {
        "name": "update_markhub_bookmark",
        "description": "Update bookmark",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}, "patch": {"type": "object"}},
            "required": ["id"],
        },
    },
    {
        "name": "delete_markhub_bookmark",
        "description": "Soft-delete bookmark",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
    },
    {
        "name": "list_markhub_folders",
        "description": "List folders",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "add_markhub_folder",
        "description": "Create folder",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "parent_id": {"type": "string"},
                "visibility": {"type": "string"},
            },
        },
    },
    {
        "name": "rename_markhub_folder",
        "description": "Rename folder",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}, "name": {"type": "string"}},
            "required": ["id", "name"],
        },
    },
    {
        "name": "delete_markhub_folder",
        "description": "Delete folder with mode",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "mode": {"type": "string"},
            },
            "required": ["id"],
        },
    },
    {
        "name": "list_markhub_tags",
        "description": "List tags",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "add_markhub_tag",
        "description": "Create tag",
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string"}, "color": {"type": "string"}},
            "required": ["name"],
        },
    },
    {
        "name": "rename_markhub_tag",
        "description": "Rename tag",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}, "name": {"type": "string"}},
            "required": ["id", "name"],
        },
    },
    {
        "name": "reorder_markhub_bookmarks",
        "description": "Reorder bookmarks in a folder",
        "inputSchema": {
            "type": "object",
            "properties": {
                "folder_id": {"type": "string"},
                "ordered_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["folder_id", "ordered_ids"],
        },
    },
    {
        "name": "reorder_markhub_folders",
        "description": "Reorder folders under parent",
        "inputSchema": {
            "type": "object",
            "properties": {
                "parent_id": {"type": "string"},
                "ordered_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["ordered_ids"],
        },
    },
    {
        "name": "list_markhub_boards",
        "description": "List boards",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "scan_board",
        "description": "Scan board full or incremental",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "mode": {"type": "string"},
            },
            "required": ["id"],
        },
    },
]


async def _user_from_bearer(token: str, db: AsyncSession) -> User | None:
    # OAuth access token
    meta = _oauth_tokens.get(token)
    if meta and meta.get("exp", 0) > time.time():
        user = (
            await db.execute(select(User).where(User.id == meta["user_id"]))
        ).scalar_one_or_none()
        if user:
            return user
    # Admin JWT (SPA / parity suite) — tools list is read-only discovery
    try:
        from app.security.auth import decode_token

        payload = decode_token(token)
        if payload and payload.get("user_id"):
            user = (
                await db.execute(select(User).where(User.id == payload["user_id"]))
            ).scalar_one_or_none()
            if user:
                return user
    except Exception:
        pass
    # MCP static bearer token (sha256 hash in settings)
    th = hashlib.sha256(token.encode()).hexdigest()
    users = (await db.execute(select(User))).scalars().all()
    for u in users:
        enabled = await get_setting(db, u.id, "mcp_enabled", "false")
        if enabled != "true":
            continue
        stored = await get_setting(db, u.id, "mcp_token_hash", "")
        if stored and stored == th:
            return u
        # Allow plaintext comparison only when hash matches freshly set token value stored as hash
    return None


async def _check_mcp_origin(request: Request, user: User, db: AsyncSession) -> None:
    """F-005: enforce mcp_allowed_origins when configured (browser Origin only)."""
    origin = request.headers.get("origin")
    if not origin:
        return  # non-browser clients have no Origin header
    allowed_raw = await get_setting(db, user.id, "mcp_allowed_origins", "")
    if not allowed_raw or not str(allowed_raw).strip():
        return
    allowed = [o.strip() for o in str(allowed_raw).split(",") if o.strip()]
    if origin not in allowed and "*" not in allowed:
        raise api_error("forbidden_origin", f"Origin not allowed: {origin}", 403)


async def _auth_mcp(
    request: Request,
    authorization: str | None = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise api_error("unauthorized", "Bearer required", 401)
    token = authorization.split(" ", 1)[1].strip()
    user = await _user_from_bearer(token, db)
    if not user:
        raise api_error("unauthorized", "Invalid MCP token", 401)
    await _check_mcp_origin(request, user, db)
    return user


class ToolCall(BaseModel):
    name: str
    arguments: dict[str, Any] = {}


class JsonRpc(BaseModel):
    jsonrpc: str = "2.0"
    id: Any = None
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


# ─── OAuth Client Credentials (KD-8) ───────────────────────


@router.post("/oauth/token")
async def oauth_token(request: Request, db: AsyncSession = Depends(get_db)):
    """OAuth2 client_credentials grant for MCP agents."""
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        body = await request.json()
    else:
        form = await request.form()
        body = dict(form)

    grant = body.get("grant_type")
    client_id = body.get("client_id") or ""
    client_secret = body.get("client_secret") or ""
    if grant != "client_credentials":
        raise api_error("invalid_grant", "grant_type must be client_credentials", 400)
    if client_id != MCP_CLIENT_ID:
        raise api_error("invalid_client", "client_id must be markhub-mcp", 401)

    # client_secret must match an enabled MCP token for some admin
    users = (await db.execute(select(User))).scalars().all()
    matched: User | None = None
    for u in users:
        enabled = await get_setting(db, u.id, "mcp_enabled", "false")
        if enabled != "true":
            continue
        stored = await get_setting(db, u.id, "mcp_token_hash", "")
        th = hashlib.sha256(str(client_secret).encode()).hexdigest()
        if stored and stored == th:
            matched = u
            break
    if not matched:
        raise api_error("invalid_client", "Invalid client_secret", 401)

    access = secrets.token_urlsafe(32)
    expires_in = 3600
    _oauth_tokens[access] = {
        "user_id": matched.id,
        "exp": time.time() + expires_in,
        "client_id": client_id,
    }
    # prune expired
    now = time.time()
    for k in list(_oauth_tokens.keys()):
        if _oauth_tokens[k]["exp"] < now:
            del _oauth_tokens[k]

    return {
        "access_token": access,
        "token_type": "bearer",
        "expires_in": expires_in,
        "scope": "mcp",
    }


# ─── Legacy REST tools (compat) ────────────────────────────


def _require_mcp_flag():
    from app.config import get_settings

    if not get_settings().ff_mcp:
        raise api_error("feature_disabled", "MCP is disabled", 503)


@router.get("/mcp/tools")
async def list_tools(_: User = Depends(_auth_mcp)):
    """List tools for admin SPA (JWT) or MCP clients (Bearer MCP/OAuth token)."""
    _require_mcp_flag()
    return {"tools": TOOLS_SPEC}


@router.post("/mcp/call")
async def call_tool(
    body: ToolCall,
    user: User = Depends(_auth_mcp),
    db: AsyncSession = Depends(get_db),
):
    _require_mcp_flag()
    return await _dispatch_tool(db, user, body.name, body.arguments or {})


# ─── Streamable HTTP MCP (JSON-RPC) ────────────────────────


@router.post("/mcp")
async def mcp_streamable(
    request: Request,
    user: User = Depends(_auth_mcp),
    db: AsyncSession = Depends(get_db),
):
    """
    MCP Streamable HTTP transport: JSON-RPC over POST /mcp.
    Accepts initialize / tools/list / tools/call. Returns JSON or SSE when Accept prefers it.
    """
    _require_mcp_flag()
    try:
        payload = await request.json()
    except Exception:
        raise api_error("validation", "Invalid JSON body")

    messages = payload if isinstance(payload, list) else [payload]
    results = []
    for msg in messages:
        try:
            rpc = JsonRpc.model_validate(msg)
        except Exception as e:
            results.append(
                {
                    "jsonrpc": "2.0",
                    "id": msg.get("id") if isinstance(msg, dict) else None,
                    "error": {"code": -32600, "message": str(e)},
                }
            )
            continue
        results.append(await _handle_rpc(db, user, rpc))

    accept = request.headers.get("accept", "")
    if "text/event-stream" in accept:
        async def gen():
            for r in results:
                yield f"data: {json.dumps(r, ensure_ascii=False)}\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    if isinstance(payload, list):
        return JSONResponse(results)
    return JSONResponse(results[0] if results else {})


@router.get("/mcp")
async def mcp_get_info(_: User = Depends(_auth_mcp)):
    return {
        "name": "markhub",
        "version": "0.1.0",
        "protocolVersion": PROTOCOL_VERSION,
        "transport": "streamable-http",
        "capabilities": {"tools": {}},
    }


async def _handle_rpc(db: AsyncSession, user: User, rpc: JsonRpc) -> dict:
    if rpc.method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": rpc.id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "markhub", "version": "0.1.0"},
            },
        }
    if rpc.method in ("notifications/initialized", "ping"):
        return {"jsonrpc": "2.0", "id": rpc.id, "result": {}}
    if rpc.method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": rpc.id,
            "result": {"tools": TOOLS_SPEC},
        }
    if rpc.method == "tools/call":
        name = (rpc.params or {}).get("name")
        arguments = (rpc.params or {}).get("arguments") or {}
        try:
            result = await _dispatch_tool(db, user, name, arguments)
            return {
                "jsonrpc": "2.0",
                "id": rpc.id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(result, ensure_ascii=False, default=str),
                        }
                    ],
                    "isError": False,
                },
            }
        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": rpc.id,
                "result": {
                    "content": [{"type": "text", "text": str(e)}],
                    "isError": True,
                },
            }
    return {
        "jsonrpc": "2.0",
        "id": rpc.id,
        "error": {"code": -32601, "message": f"Method not found: {rpc.method}"},
    }


async def _dispatch_tool(
    db: AsyncSession, user: User, name: str, a: dict[str, Any]
) -> Any:
    if name == "list_markhub_bookmarks":
        return await bm_svc.list_bookmarks(
            db,
            user.id,
            folder_id=a.get("folder_id"),
            q=a.get("query"),
            limit=a.get("limit", 100),
        )
    if name == "get_markhub_bookmark":
        b = await bm_svc.get_bookmark(db, user.id, a["id"])
        from app.domain.bookmarks import _tags_for
        from app.domain.serializers import bookmark_dict

        return bookmark_dict(b, await _tags_for(db, b.id))
    if name == "add_markhub_bookmark":
        return await bm_svc.create_bookmark(db, user.id, a)
    if name == "update_markhub_bookmark":
        return await bm_svc.update_bookmark(db, user.id, a["id"], a.get("patch") or a)
    if name == "delete_markhub_bookmark":
        return await bm_svc.delete_bookmark(db, user.id, a["id"])
    if name == "list_markhub_folders":
        return {"items": await folder_svc.list_folders(db, user.id)}
    if name == "add_markhub_folder":
        return await folder_svc.create_folder(
            db,
            user.id,
            a.get("name", "Folder"),
            parent_id=a.get("parent_id"),
            visibility=a.get("visibility", "private"),
        )
    if name == "rename_markhub_folder":
        return await folder_svc.update_folder(db, user.id, a["id"], {"name": a["name"]})
    if name == "delete_markhub_folder":
        return await folder_svc.delete_folder(
            db, user.id, a["id"], mode=a.get("mode", "move_to_parent")
        )
    if name == "list_markhub_tags":
        return {"items": await tag_svc.list_tags(db, user.id)}
    if name == "add_markhub_tag":
        return await tag_svc.create_tag(db, user.id, a["name"], a.get("color"))
    if name == "rename_markhub_tag":
        return await tag_svc.update_tag(db, user.id, a["id"], name=a["name"])
    if name == "reorder_markhub_bookmarks":
        return await bm_svc.reorder_bookmarks(
            db, user.id, a["folder_id"], a["ordered_ids"]
        )
    if name == "reorder_markhub_folders":
        return await folder_svc.reorder_folders(
            db, user.id, a.get("parent_id"), a["ordered_ids"]
        )
    if name == "list_markhub_boards":
        from app.domain import boards as board_svc

        return {"items": await board_svc.list_boards(db, user.id)}
    if name == "scan_board":
        from app.domain import boards as board_svc

        return await board_svc.scan_board(
            db, user.id, a["id"], mode=a.get("mode", "full")
        )
    raise api_error("unknown_tool", f"Unknown tool: {name}")
