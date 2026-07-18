from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import Bookmark, Folder, Setting, User
from app.security.auth import hash_password
from app.utils.timeutil import server_now


async def bootstrap_admin_and_inbox(db: AsyncSession) -> User:
    """Empty DB: create single admin + system inbox (KD-29)."""
    settings = get_settings()
    result = await db.execute(select(User).limit(1))
    user = result.scalar_one_or_none()
    created_user = user is None
    if user is None:
        user = User(
            username=settings.default_admin_username,
            password_hash=hash_password(settings.default_admin_password),
            must_change_password=settings.force_admin_password_change,
            created_at=server_now(),
            updated_at=server_now(),
        )
        db.add(user)
        await db.flush()

    # Ensure inbox
    inbox_q = await db.execute(
        select(Folder).where(
            Folder.user_id == user.id,
            Folder.is_system == True,  # noqa: E712
            Folder.deleted_at.is_(None),
        )
    )
    inbox = inbox_q.scalar_one_or_none()
    if inbox is None:
        inbox = Folder(
            user_id=user.id,
            parent_id=None,
            name="Inbox",
            sort_order=0,
            visibility="private",
            is_system=True,
            created_at=server_now(),
            updated_at=server_now(),
        )
        db.add(inbox)
        await db.flush()

    # settings.inbox_folder_id
    s_q = await db.execute(
        select(Setting).where(Setting.user_id == user.id, Setting.key == "inbox_folder_id")
    )
    if s_q.scalar_one_or_none() is None:
        db.add(
            Setting(
                user_id=user.id,
                key="inbox_folder_id",
                value=inbox.id,
                is_secret=False,
            )
        )
    await db.flush()

    # Seed prototype demo library once (fresh empty library). Skip under pytest.
    import os

    testing = (
        os.environ.get("MARKHUB_TESTING") == "1"
        or bool(os.environ.get("PYTEST_CURRENT_TEST"))
        or "pytest" in os.environ.get("_", "")
    )
    if (
        settings.seed_demo_data
        and not testing
        and (created_user or await _library_is_empty(db, user.id))
    ):
        await seed_demo_library(db, user.id, inbox.id)

    return user


async def _library_is_empty(db: AsyncSession, user_id: str) -> bool:
    n = (
        await db.execute(
            select(func.count())
            .select_from(Bookmark)
            .where(Bookmark.user_id == user_id, Bookmark.deleted_at.is_(None))
        )
    ).scalar_one()
    # Only seed when there are zero bookmarks AND only system folder(s)
    non_system = (
        await db.execute(
            select(func.count())
            .select_from(Folder)
            .where(
                Folder.user_id == user_id,
                Folder.is_system == False,  # noqa: E712
                Folder.deleted_at.is_(None),
            )
        )
    ).scalar_one()
    return int(n or 0) == 0 and int(non_system or 0) == 0


async def seed_demo_library(db: AsyncSession, user_id: str, inbox_id: str) -> None:
    """Seed folders/bookmarks matching ui-design MarkHub prototype mock data."""
    # Guard: never re-seed if demo marker present
    marker = (
        await db.execute(
            select(Setting).where(
                Setting.user_id == user_id, Setting.key == "demo_seeded"
            )
        )
    ).scalar_one_or_none()
    if marker is not None:
        return

    from app.domain.bookmarks import create_bookmark
    from app.domain.folders import create_folder

    f_dev = await create_folder(db, user_id, "开发工具", visibility="public", sort_order=10)
    f_fe = await create_folder(
        db, user_id, "前端", parent_id=f_dev["id"], visibility="public", sort_order=11
    )
    f_ops = await create_folder(
        db, user_id, "DevOps", parent_id=f_dev["id"], visibility="public", sort_order=12
    )
    f_design = await create_folder(db, user_id, "设计资源", visibility="public", sort_order=20)
    f_ai = await create_folder(db, user_id, "AI & 论文", visibility="public", sort_order=30)
    f_read = await create_folder(db, user_id, "阅读清单", visibility="unlisted", sort_order=40)
    await create_folder(db, user_id, "临时资料", visibility="private", sort_order=50)

    # (folder_id, title, url, desc, tags, visibility, link_status)
    items: list[tuple] = [
        (
            f_dev["id"],
            "GitHub",
            "https://github.com",
            "全球最大的代码托管与协作平台",
            ["opensource", "daily"],
            "public",
            "ok",
        ),
        (
            f_dev["id"],
            "MDN Web Docs",
            "https://developer.mozilla.org",
            "Web 标准与 API 权威文档",
            ["docs"],
            "public",
            "ok",
        ),
        (
            f_dev["id"],
            "Stack Overflow",
            "https://stackoverflow.com",
            "程序员问答社区",
            ["qa"],
            "public",
            "ok",
        ),
        (
            f_fe["id"],
            "Vercel",
            "https://vercel.com",
            "前端部署与托管平台",
            ["deploy"],
            "public",
            "ok",
        ),
        (
            f_fe["id"],
            "React 文档",
            "https://react.dev",
            "React 官方文档与教程",
            ["docs", "frontend"],
            "public",
            "ok",
        ),
        (
            f_fe["id"],
            "Vite",
            "https://vitejs.dev",
            "下一代前端构建工具",
            ["build"],
            "public",
            "ok",
        ),
        (
            f_ops["id"],
            "Docker Hub",
            "https://hub.docker.com",
            "容器镜像仓库",
            ["container"],
            "public",
            "ok",
        ),
        (
            f_ops["id"],
            "Cloudflare Dash",
            "https://dash.cloudflare.com",
            "Workers / D1 / R2 控制台",
            ["deploy", "daily"],
            "public",
            "ok",
        ),
        (
            f_design["id"],
            "Figma",
            "https://figma.com",
            "协作界面设计工具",
            [],
            "public",
            "ok",
        ),
        (
            f_design["id"],
            "Dribbble",
            "https://dribbble.com",
            "设计灵感与作品集社区",
            [],
            "public",
            "ok",
        ),
        (
            f_design["id"],
            "Coolors",
            "https://coolors.co",
            "配色方案生成器",
            [],
            "public",
            "ok",
        ),
        (
            f_design["id"],
            "Product Hunt",
            "https://producthunt.com",
            "新产品发现社区",
            [],
            "public",
            "ok",
        ),
        (
            f_ai["id"],
            "arXiv",
            "https://arxiv.org",
            "论文预印本平台",
            ["paper"],
            "public",
            "ok",
        ),
        (
            f_ai["id"],
            "Hugging Face",
            "https://huggingface.co",
            "开源模型与数据集社区",
            ["ml"],
            "public",
            "ok",
        ),
        (
            f_ai["id"],
            "Claude",
            "https://claude.ai",
            "Anthropic AI 助手",
            ["ai", "daily"],
            "public",
            "ok",
        ),
        (
            f_ai["id"],
            "OpenAI Platform",
            "https://platform.openai.com",
            "API 文档与控制台",
            ["ai"],
            "public",
            "ok",
        ),
        (
            f_read["id"],
            "Hacker News",
            "https://news.ycombinator.com",
            "技术新闻社区",
            ["daily"],
            "public",
            "ok",
        ),
        (
            f_read["id"],
            "阮一峰周刊",
            "https://www.ruanyifeng.com/blog/weekly/",
            "科技爱好者周刊，每周五发布",
            ["weekly"],
            "public",
            "ok",
        ),
        (
            inbox_id,
            "旧项目文档",
            "https://old-docs.example.com",
            "已迁移的旧文档站",
            [],
            "private",
            "dead",
        ),
        (
            inbox_id,
            "GitHub (重复导入)",
            "https://github.com/?utm_source=old",
            "重复导入的副本",
            [],
            "private",
            "ok",
        ),
    ]

    for folder_id, title, url, desc, tags, vis, link_status in items:
        await create_bookmark(
            db,
            user_id,
            {
                "folder_id": folder_id,
                "title": title,
                "url": url,
                "description": desc,
                "tags": tags,
                "visibility": vis,
                "link_status": link_status,
            },
        )

    db.add(
        Setting(
            user_id=user_id,
            key="demo_seeded",
            value="1",
            is_secret=False,
        )
    )
    await db.flush()


async def get_inbox_folder_id(db: AsyncSession, user_id: str) -> str:
    s_q = await db.execute(
        select(Setting).where(Setting.user_id == user_id, Setting.key == "inbox_folder_id")
    )
    s = s_q.scalar_one_or_none()
    if s and s.value:
        return s.value
    f_q = await db.execute(
        select(Folder).where(
            Folder.user_id == user_id,
            Folder.is_system == True,  # noqa: E712
            Folder.deleted_at.is_(None),
        )
    )
    f = f_q.scalar_one()
    return f.id
