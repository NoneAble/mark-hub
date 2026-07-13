from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.domain import ai_svc
from app.models import User
from app.security.auth import get_current_user

router = APIRouter(prefix="/ai", tags=["ai"])


class ClassifyBody(BaseModel):
    title: str = ""
    url: str
    description: str = ""


class SummarizeBody(BaseModel):
    title: str = ""
    url: str
    description: str = ""


class FetchBody(BaseModel):
    url: str


class QuickAddBody(BaseModel):
    url: str
    title: str | None = None
    folder_id: str | None = None


class BatchBody(BaseModel):
    bookmark_ids: list[str]
    actions: list[str] = ["summarize"]


class ChatBody(BaseModel):
    messages: list[dict]


@router.get("/status")
async def status(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return await ai_svc.ai_status(db, user.id)


@router.post("/classify")
async def classify(
    body: ClassifyBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await ai_svc.classify(db, user.id, body.title, body.url, body.description)


@router.post("/summarize")
async def summarize(
    body: SummarizeBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await ai_svc.summarize(db, user.id, body.title, body.url, body.description)


@router.post("/fetch-page-info")
async def fetch_page_info(
    body: FetchBody,
    user: User = Depends(get_current_user),
):
    # F-002: page-fetch proxy requires administrator authentication
    _ = user
    return await ai_svc.fetch_page_info(body.url)


@router.post("/quick-add")
async def quick_add(
    body: QuickAddBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await ai_svc.quick_add(db, user.id, body.url, folder_id=body.folder_id, title=body.title)


@router.post("/quick-add/with-title")
async def quick_add_title(
    body: QuickAddBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await ai_svc.quick_add(
        db, user.id, body.url, with_title=True, folder_id=body.folder_id, title=body.title
    )


@router.post("/quick-add/with-category")
async def quick_add_category(
    body: QuickAddBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await ai_svc.quick_add(
        db,
        user.id,
        body.url,
        with_title=True,
        with_category=True,
        folder_id=body.folder_id,
        title=body.title,
    )


@router.post("/batch")
async def batch(
    body: BatchBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.config import get_settings
    from app.utils.errors import api_error

    if not get_settings().ff_ai_batch:
        raise api_error("feature_disabled", "AI batch is disabled", 503)
    return await ai_svc.create_batch_task(db, user.id, body.bookmark_ids, body.actions)


@router.get("/tasks")
async def tasks(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return {"items": await ai_svc.list_tasks(db, user.id)}


@router.get("/tasks/{task_id}")
async def task(
    task_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await ai_svc.get_task(db, user.id, task_id)


@router.post("/chat")
async def chat(
    body: ChatBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    stream: bool = Query(True, description="SSE stream when true (default)"),
):
    if not stream:
        return await ai_svc.chat(db, user.id, body.messages)

    async def event_gen():
        async for chunk in ai_svc.chat_stream(db, user.id, body.messages):
            yield chunk

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

