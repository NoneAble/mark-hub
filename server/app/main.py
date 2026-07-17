from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import __version__
from app.api import (
    auth,
    backup,
    bookmarks,
    folders,
    nav,
    shares,
    system,
    tags,
)
from app.config import assert_secure_or_exit, get_settings
from app.database import async_session_maker, init_db
from app.domain.bootstrap import bootstrap_admin_and_inbox
from app.jobs.scheduler import init_scheduler, shutdown_scheduler

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("markhub")


@asynccontextmanager
async def lifespan(app: FastAPI):
    assert_secure_or_exit()
    cfg = get_settings()
    # Ensure data dir for sqlite
    if cfg.database_url.startswith("sqlite"):
        # sqlite+aiosqlite:///./data/markhub.db
        path_part = cfg.database_url.split("///")[-1]
        Path(path_part).parent.mkdir(parents=True, exist_ok=True)

    await init_db()
    async with async_session_maker() as session:
        await bootstrap_admin_and_inbox(session)
        await session.commit()
    try:
        init_scheduler()
    except Exception as e:
        logger.warning("Scheduler init failed: %s", e)
    logger.info("MarkHub API %s started", __version__)
    yield
    shutdown_scheduler()
    logger.info("MarkHub API stopped")


cfg = get_settings()

app = FastAPI(
    title="MarkHub API",
    description="Self-hosted bookmark hub — Docker + Cloudflare",
    version=__version__,
    lifespan=lifespan,
)

origins = (
    cfg.cors_origins.split(",")
    if cfg.cors_origins != "*"
    else ["*"]
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_observability(request: Request, call_next):
    """JSON request logs with request_id, path, latency, actor (F-019).

    Also updates in-process metrics counters (R4-F002).
    """
    from app.api import system as system_api

    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    request.state.request_id = request_id
    t0 = time.perf_counter()
    actor = "bearer" if (request.headers.get("authorization") or "").lower().startswith("bearer ") else "-"
    try:
        response = await call_next(request)
    except Exception:
        latency_ms = int((time.perf_counter() - t0) * 1000)
        system_api.record_request(status_code=500)
        logger.exception(
            '{"request_id":"%s","method":"%s","path":"%s","status":500,"latency_ms":%s,"actor":"%s"}',
            request_id, request.method, request.url.path, latency_ms, actor,
        )
        raise
    latency_ms = int((time.perf_counter() - t0) * 1000)
    system_api.record_request(status_code=response.status_code)
    response.headers["X-Request-Id"] = request_id
    logger.info(
        '{"request_id":"%s","method":"%s","path":"%s","status":%s,"latency_ms":%s,"actor":"%s"}',
        request_id, request.method, request.url.path, response.status_code, latency_ms, actor,
    )
    return response



@app.exception_handler(StarletteHTTPException)
async def http_exc_handler(_request: Request, exc: StarletteHTTPException):
    detail = exc.detail
    if isinstance(detail, dict) and "error" in detail:
        return JSONResponse(status_code=exc.status_code, content=detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": "http_error", "message": str(detail)}},
    )


@app.exception_handler(RequestValidationError)
async def validation_exc_handler(_request: Request, exc: RequestValidationError):
    """Uniform error envelope for Pydantic/request validation (F-012)."""
    errors = exc.errors()
    messages = []
    for e in errors:
        loc = ".".join(str(x) for x in e.get("loc", ()) if x != "body")
        msg = e.get("msg", "invalid")
        messages.append(f"{loc}: {msg}" if loc else msg)
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "validation",
                "message": "; ".join(messages) or "Validation failed",
                "details": errors,
            }
        },
    )


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    if isinstance(exc, (HTTPException, StarletteHTTPException)):
        return await http_exc_handler(request, exc)  # type: ignore[arg-type]
    logger.exception("Unhandled error on %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "internal", "message": "Internal server error"}},
    )


API = "/api/v1"

app.include_router(system.router, prefix=API)
app.include_router(auth.router, prefix=API)
app.include_router(bookmarks.router, prefix=API)
app.include_router(folders.router, prefix=API)
app.include_router(tags.router, prefix=API)
app.include_router(nav.router, prefix=API)
app.include_router(backup.router, prefix=API)
app.include_router(shares.router, prefix=API)


# Serve SPA if built assets are present (Docker / local static)
# SPA history fallback for client routes (F-009)
_web_dist = Path(__file__).resolve().parents[2] / "web-dist"
if not _web_dist.is_dir():
    _web_dist = Path(__file__).resolve().parents[2] / "apps" / "web" / "dist"


def _spa_index() -> Path | None:
    idx = _web_dist / "index.html"
    return idx if idx.is_file() else None


if _web_dist.is_dir() and _spa_index() is not None:
    # Static assets (js/css/images) — real missing assets still 404
    assets_dir = _web_dist / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        # Never swallow API routes (mounted above; this is a last-resort catch-all)
        if full_path.startswith("api/"):
            return JSONResponse(
                status_code=404,
                content={"error": {"code": "not_found", "message": "Not found"}},
            )
        # Serve real files when present (favicon, robots, etc.)
        candidate = (_web_dist / full_path).resolve()
        try:
            candidate.relative_to(_web_dist.resolve())
        except ValueError:
            return JSONResponse(
                status_code=404,
                content={"error": {"code": "not_found", "message": "Not found"}},
            )
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        # Client-side routes → index.html
        return FileResponse(_spa_index())
else:

    @app.get("/")
    async def root():
        return {"name": "MarkHub", "version": __version__, "api": API}
