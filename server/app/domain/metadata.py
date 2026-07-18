"""Fetch page metadata (title / description / favicon) for the add-bookmark form.

Uses the SSRF-guarded fetcher; downloaded favicons are stored under the local
data dir and served back at ``/api/icons/favicons/<uuid>.<ext>``.
"""

from __future__ import annotations

import logging
import re
import uuid
from pathlib import Path
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from app.utils.ssrf import safe_fetch

logger = logging.getLogger("markhub.metadata")

MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_ICON_BYTES = 1 * 1024 * 1024

ICON_CONTENT_TYPES = {
    "image/png": "png",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
    "image/ico": "ico",
    "image/svg+xml": "svg",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
}
ICON_EXT_RE = re.compile(r"\.(png|ico|svg|jpe?g|gif|webp)(?:\?.*)?$", re.IGNORECASE)
SAFE_ICON_NAME = re.compile(r"^[a-f0-9-]{36}\.(png|ico|svg|jpg|gif|webp)$")

ICONS_URL_PREFIX = "/api/icons/favicons/"


def favicons_dir() -> Path:
    """Directory for downloaded favicons, alongside the sqlite data dir."""
    d = Path("./data/icons/favicons")
    d.mkdir(parents=True, exist_ok=True)
    return d


def _meta_content(soup: BeautifulSoup, *selectors: tuple[str, str]) -> str:
    for attr, value in selectors:
        el = soup.find("meta", attrs={attr: value})
        if el and el.get("content"):
            return str(el["content"]).strip()
    return ""


def _icon_candidates(soup: BeautifulSoup, base_url: str) -> list[str]:
    scored: list[tuple[int, str]] = []
    for link in soup.find_all("link"):
        rel = " ".join(link.get("rel") or []).lower()
        href = (link.get("href") or "").strip()
        if not href or "icon" not in rel:
            continue
        score = 0
        if "apple-touch-icon" in rel:
            score += 3
        href_l = href.lower()
        if href_l.endswith(".png") or "png" in (link.get("type") or ""):
            score += 2
        if href_l.endswith(".svg"):
            score += 1
        sizes = (link.get("sizes") or "").lower()
        m = re.match(r"(\d+)x", sizes)
        if m:
            px = int(m.group(1))
            # Prefer crisp mid-size icons (~64px) over tiny 16px or huge 512px
            score += 2 - abs(px - 64) // 64
        scored.append((score, urljoin(base_url, href)))
    scored.sort(key=lambda x: -x[0])
    out = [u for _, u in scored]
    p = urlparse(base_url)
    out.append(f"{p.scheme}://{p.netloc}/favicon.ico")
    return out


async def _download_icon(icon_url: str) -> str | None:
    """Download one icon candidate; return served path or None."""
    try:
        r = await safe_fetch(icon_url, timeout=8.0)
    except Exception:
        return None
    if r.status_code != 200 or not r.content or len(r.content) > MAX_ICON_BYTES:
        return None
    ctype = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
    ext = ICON_CONTENT_TYPES.get(ctype)
    if not ext:
        m = ICON_EXT_RE.search(icon_url)
        if not m:
            return None
        ext = m.group(1).lower().replace("jpeg", "jpg")
    name = f"{uuid.uuid4()}.{ext}"
    (favicons_dir() / name).write_bytes(r.content)
    return ICONS_URL_PREFIX + name


async def fetch_page_metadata(url: str) -> dict:
    """Fetch title/description/icon for a URL. Raises ValueError on bad input."""
    url = (url or "").strip()
    if url and "://" not in url:
        url = f"https://{url}"
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("invalid_url")

    resp = await safe_fetch(url, timeout=12.0)
    body = resp.content[:MAX_PAGE_BYTES]
    soup = BeautifulSoup(body, "lxml")

    title = _meta_content(soup, ("property", "og:title"), ("name", "twitter:title"))
    if not title and soup.title and soup.title.string:
        title = soup.title.string.strip()
    description = _meta_content(
        soup,
        ("property", "og:description"),
        ("name", "description"),
        ("name", "twitter:description"),
    )

    icon_path: str | None = None
    for cand in _icon_candidates(soup, url)[:4]:
        icon_path = await _download_icon(cand)
        if icon_path:
            break

    return {
        "url": url,
        "title": title,
        "description": description,
        "icon": icon_path or "",
    }
