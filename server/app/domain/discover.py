"""Discover widget registry — server-side fetch (F-017)."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.settings_svc import get_json_setting
from app.utils.ssrf import safe_fetch

REGISTRY = {
    "github_trending": {
        "name": "GitHub Trending",
        "url": "https://api.github.com/search/repositories?q=stars:>1&sort=stars&order=desc&per_page=10",
    },
    "newsnow": {
        "name": "NewsNow",
        "url": "https://newsnow.busiyi.world/api/s?id=toutiao&latest",
    },
    "info_entries": {
        "name": "Info entries",
        "url": None,  # from settings
    },
}


async def fetch_widgets(
    db: AsyncSession,
    user_id: str,
    ids: list[str] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    wanted = ids or list(REGISTRY.keys())
    out: dict[str, list[dict[str, Any]]] = {}
    for wid in wanted:
        if wid not in REGISTRY:
            out[wid] = []
            continue
        try:
            out[wid] = await _fetch_one(db, user_id, wid)
        except Exception:
            out[wid] = []
    return out


async def _fetch_one(db: AsyncSession, user_id: str, wid: str) -> list[dict[str, Any]]:
    if wid == "info_entries":
        entries = await get_json_setting(db, user_id, "info_entries", []) or []
        if not isinstance(entries, list):
            return []
        return [
            {
                "title": str(e.get("title") or e.get("name") or "Entry"),
                "url": str(e.get("url") or "#"),
                "meta": str(e.get("meta") or e.get("note") or ""),
            }
            for e in entries
            if isinstance(e, dict)
        ][:20]

    if wid == "github_trending":
        r = await safe_fetch(
            REGISTRY[wid]["url"],  # type: ignore[arg-type]
            method="GET",
            timeout=8.0,
            max_redirects=2,
            headers={
                "User-Agent": "MarkHub/0.1",
                "Accept": "application/vnd.github+json",
            },
        )
        data = r.json()
        items = data.get("items") or []
        return [
            {
                "title": it.get("full_name") or it.get("name") or "repo",
                "url": it.get("html_url") or "#",
                "meta": f"★ {it.get('stargazers_count', 0)}",
            }
            for it in items[:10]
        ]

    if wid == "newsnow":
        # Best-effort public feed; failures return empty
        try:
            r = await safe_fetch(
                REGISTRY[wid]["url"],  # type: ignore[arg-type]
                method="GET",
                timeout=8.0,
                max_redirects=2,
            )
            data = r.json()
            items = data.get("items") or data.get("data") or []
            if isinstance(items, dict):
                items = items.get("items") or []
            return [
                {
                    "title": str(it.get("title") or it.get("name") or "news"),
                    "url": str(it.get("url") or it.get("mobileUrl") or "#"),
                    "meta": str(it.get("extra") or it.get("pubDate") or ""),
                }
                for it in items[:15]
                if isinstance(it, dict)
            ]
        except Exception:
            return [
                {
                    "title": "NewsNow feed unavailable",
                    "url": "https://newsnow.busiyi.world/",
                    "meta": "open site",
                }
            ]

    return []
