from __future__ import annotations

import json
from typing import Any

from bs4 import BeautifulSoup
from openai import AsyncOpenAI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain import bookmarks as bm_svc
from app.domain.settings_svc import get_setting, set_setting
from app.models import AiTask, Bookmark, Folder
from app.utils.errors import api_error
from app.utils.ssrf import assert_safe_url
from app.utils.timeutil import server_now


async def get_ai_config(db: AsyncSession, user_id: str) -> dict:
    api_key = await get_setting(db, user_id, "ai_api_key", "")
    return {
        "ai_provider": await get_setting(db, user_id, "ai_provider", "openai") or "openai",
        "ai_base_url": await get_setting(db, user_id, "ai_base_url", "https://api.openai.com/v1")
        or "https://api.openai.com/v1",
        "ai_model": await get_setting(db, user_id, "ai_model", "gpt-4o-mini") or "gpt-4o-mini",
        "ai_api_key_set": bool(api_key),
    }


async def save_ai_config(db: AsyncSession, user_id: str, data: dict) -> dict:
    if "ai_provider" in data and data["ai_provider"] is not None:
        await set_setting(db, user_id, "ai_provider", str(data["ai_provider"]))
    if "ai_base_url" in data and data["ai_base_url"] is not None:
        await set_setting(db, user_id, "ai_base_url", str(data["ai_base_url"]))
    if "ai_model" in data and data["ai_model"] is not None:
        await set_setting(db, user_id, "ai_model", str(data["ai_model"]))
    if data.get("ai_api_key"):
        await set_setting(db, user_id, "ai_api_key", str(data["ai_api_key"]), is_secret=True)
    return await get_ai_config(db, user_id)


async def _client(db: AsyncSession, user_id: str) -> AsyncOpenAI:
    key = await get_setting(db, user_id, "ai_api_key", "")
    if not key:
        raise api_error("ai_not_configured", "AI API key not set", 400)
    base = await get_setting(db, user_id, "ai_base_url", "https://api.openai.com/v1")
    return AsyncOpenAI(api_key=key, base_url=base or "https://api.openai.com/v1")


async def ai_status(db: AsyncSession, user_id: str) -> dict:
    cfg = await get_ai_config(db, user_id)
    return {
        "configured": cfg["ai_api_key_set"],
        "model": cfg["ai_model"],
        "provider": cfg["ai_provider"],
        "base_url": cfg["ai_base_url"],
    }


async def test_ai(db: AsyncSession, user_id: str) -> dict:
    client = await _client(db, user_id)
    model = await get_setting(db, user_id, "ai_model", "gpt-4o-mini")
    try:
        r = await client.chat.completions.create(
            model=model or "gpt-4o-mini",
            messages=[{"role": "user", "content": "ping"}],
            max_tokens=5,
        )
        return {"ok": True, "reply": (r.choices[0].message.content or "")[:100]}
    except Exception as e:
        return {"ok": False, "message": str(e)[:300]}


async def fetch_page_info(url: str) -> dict:
    from app.utils.ssrf import safe_fetch

    target = url if "://" in url else f"https://{url}"
    ok, reason = assert_safe_url(target)
    if not ok:
        raise api_error("ssrf", reason, 400)
    try:
        r = await safe_fetch(target, method="GET", timeout=10.0, max_redirects=5)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "lxml")
        title = (soup.title.string if soup.title else "") or ""
        desc = ""
        md = soup.find("meta", attrs={"name": "description"}) or soup.find(
            "meta", attrs={"property": "og:description"}
        )
        if md and md.get("content"):
            desc = md["content"]
        return {
            "url": str(r.url),
            "title": title.strip()[:500],
            "description": desc.strip()[:2000],
            "status_code": r.status_code,
        }
    except Exception as e:
        raise api_error("fetch_failed", str(e)[:300], 400)


async def _chat_json(
    db: AsyncSession, user_id: str, system: str, user: str
) -> str:
    client = await _client(db, user_id)
    model = await get_setting(db, user_id, "ai_model", "gpt-4o-mini")
    r = await client.chat.completions.create(
        model=model or "gpt-4o-mini",
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0.3,
    )
    return (r.choices[0].message.content or "").strip()


async def classify(db: AsyncSession, user_id: str, title: str, url: str, description: str = "") -> dict:
    folders = list(
        (
            await db.execute(
                select(Folder).where(
                    Folder.user_id == user_id, Folder.deleted_at.is_(None)
                )
            )
        )
        .scalars()
        .all()
    )
    names = [f.name for f in folders if not f.is_system][:50]
    text = await _chat_json(
        db,
        user_id,
        "You classify bookmarks. Reply with a single category name only.",
        f"Title: {title}\nURL: {url}\nDesc: {description}\nKnown categories: {', '.join(names) or 'General'}",
    )
    return {"category": text.split("\n")[0][:100]}


async def summarize(db: AsyncSession, user_id: str, title: str, url: str, description: str = "") -> dict:
    text = await _chat_json(
        db,
        user_id,
        "Summarize the bookmark in 1-2 short sentences.",
        f"Title: {title}\nURL: {url}\nDesc: {description}",
    )
    return {"summary": text[:1000]}


async def quick_add(
    db: AsyncSession,
    user_id: str,
    url: str,
    *,
    with_title: bool = False,
    with_category: bool = False,
    title: str | None = None,
    folder_id: str | None = None,
) -> dict:
    info = {"title": title or url, "description": ""}
    try:
        info = await fetch_page_info(url)
    except Exception:
        pass
    final_title = title or info.get("title") or url
    ai_category = None
    ai_summary = None
    if with_title or with_category:
        try:
            if with_category:
                ai_category = (await classify(db, user_id, final_title, url, info.get("description") or "")).get(
                    "category"
                )
            ai_summary = (await summarize(db, user_id, final_title, url, info.get("description") or "")).get(
                "summary"
            )
        except Exception:
            pass
    bm = await bm_svc.create_bookmark(
        db,
        user_id,
        {
            "title": final_title,
            "url": url,
            "description": info.get("description"),
            "folder_id": folder_id,
            "ai_category": ai_category,
            "ai_summary": ai_summary,
            "visibility": "private",
        },
    )
    return bm


async def _chat_context(db: AsyncSession, user_id: str) -> str:
    bms = list(
        (
            await db.execute(
                select(Bookmark)
                .where(Bookmark.user_id == user_id, Bookmark.deleted_at.is_(None))
                .limit(20)
            )
        )
        .scalars()
        .all()
    )
    folders = list(
        (
            await db.execute(
                select(Folder).where(
                    Folder.user_id == user_id, Folder.deleted_at.is_(None)
                )
            )
        )
        .scalars()
        .all()
    )
    return (
        f"User has {len(folders)} folders. Sample bookmarks: "
        + "; ".join(f"{b.title} ({b.url})" for b in bms[:10])
    )


async def chat(
    db: AsyncSession, user_id: str, messages: list[dict[str, str]]
) -> dict:
    """Non-streaming chat (JSON). Prefer chat_stream for SSE (F-014)."""
    ctx = await _chat_context(db, user_id)
    client = await _client(db, user_id)
    model = await get_setting(db, user_id, "ai_model", "gpt-4o-mini")
    full_messages = [
        {
            "role": "system",
            "content": f"You are MarkHub assistant. Context: {ctx}",
        },
        *messages,
    ]
    r = await client.chat.completions.create(
        model=model or "gpt-4o-mini",
        messages=full_messages,
        temperature=0.5,
    )
    return {"reply": r.choices[0].message.content or "", "model": model}


async def chat_stream(db: AsyncSession, user_id: str, messages: list[dict[str, str]]):
    """
    Async generator yielding SSE event strings for AI chat (F-014).
    Events: data: {"delta": "..."} / data: {"done": true} / data: {"error": "..."}.
    """
    try:
        ctx = await _chat_context(db, user_id)
        client = await _client(db, user_id)
        model = await get_setting(db, user_id, "ai_model", "gpt-4o-mini")
        full_messages = [
            {
                "role": "system",
                "content": f"You are MarkHub assistant. Context: {ctx}",
            },
            *messages,
        ]
        stream = await client.chat.completions.create(
            model=model or "gpt-4o-mini",
            messages=full_messages,
            temperature=0.5,
            stream=True,
        )
        async for chunk in stream:
            try:
                delta = chunk.choices[0].delta.content or ""
            except Exception:
                delta = ""
            if delta:
                yield f"data: {json.dumps({'delta': delta}, ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps({'done': True, 'model': model})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'error': str(e)[:300]})}\n\n"



async def create_batch_task(
    db: AsyncSession, user_id: str, bookmark_ids: list[str], actions: list[str]
) -> dict:
    """Enqueue AI batch work; return promptly with pending status (F-016)."""
    task = AiTask(
        user_id=user_id,
        kind="batch",
        status="pending",
        payload=json.dumps({"bookmark_ids": bookmark_ids, "actions": actions}),
        created_at=server_now(),
    )
    db.add(task)
    await db.flush()
    task_id = task.id
    await db.commit()

    from app.jobs.runner import enqueue

    enqueue(_run_batch_task(task_id, user_id))
    return {"id": task_id, "status": "pending", "error": None}


async def _run_batch_task(task_id: str, user_id: str) -> None:
    from app.database import async_session_maker

    async with async_session_maker() as db:
        task = (
            await db.execute(
                select(AiTask).where(AiTask.id == task_id, AiTask.user_id == user_id)
            )
        ).scalar_one_or_none()
        if not task:
            return
        task.status = "running"
        await db.commit()
        try:
            payload = json.loads(task.payload or "{}")
            bookmark_ids = payload.get("bookmark_ids") or []
            actions = payload.get("actions") or ["summarize"]
            results = []
            for bid in bookmark_ids:
                b = (
                    await db.execute(
                        select(Bookmark).where(
                            Bookmark.id == bid,
                            Bookmark.user_id == user_id,
                            Bookmark.deleted_at.is_(None),
                        )
                    )
                ).scalar_one_or_none()
                if not b:
                    continue
                item: dict[str, Any] = {"id": bid}
                patch: dict[str, Any] = {}
                if "summarize" in actions:
                    s = await summarize(db, user_id, b.title, b.url, b.description or "")
                    patch["ai_summary"] = s.get("summary")
                    item["summary"] = patch["ai_summary"]
                if "classify" in actions:
                    c = await classify(db, user_id, b.title, b.url, b.description or "")
                    patch["ai_category"] = c.get("category")
                    item["category"] = patch["ai_category"]
                if patch:
                    # KD-25 / F-009: domain write path + op_log, not raw column updates
                    await bm_svc.update_bookmark(db, user_id, bid, patch)
                results.append(item)
            task.result = json.dumps({"items": results})
            task.status = "done"
            task.progress = 1.0
            task.finished_at = server_now()
            await db.commit()
        except Exception as e:
            task.status = "failed"
            task.error = str(e)[:500]
            task.finished_at = server_now()
            await db.commit()


async def get_task(db: AsyncSession, user_id: str, task_id: str) -> dict:
    t = (
        await db.execute(
            select(AiTask).where(AiTask.id == task_id, AiTask.user_id == user_id)
        )
    ).scalar_one_or_none()
    if not t:
        raise api_error("not_found", "Task not found", 404)
    return {
        "id": t.id,
        "status": t.status,
        "progress": t.progress,
        "result": json.loads(t.result or "{}"),
        "error": t.error,
    }


async def list_tasks(db: AsyncSession, user_id: str) -> list[dict]:
    rows = (
        await db.execute(
            select(AiTask)
            .where(AiTask.user_id == user_id)
            .order_by(AiTask.created_at.desc())
            .limit(50)
        )
    ).scalars().all()
    return [
        {"id": t.id, "status": t.status, "progress": t.progress, "kind": t.kind}
        for t in rows
    ]
