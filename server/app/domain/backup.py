from __future__ import annotations

import csv
import io
import json
import re
from html import escape
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain import bookmarks as bm_svc
from app.domain import folders as folder_svc
from app.domain import tags as tag_svc
from app.domain.bootstrap import get_inbox_folder_id
from app.domain.serializers import tag_dict
from app.models import Bookmark, Folder, Tag
from app.utils.errors import api_error
from app.utils.normalize import normalize_url
from app.utils.timeutil import server_now

BackupFormat = Literal["json", "csv", "html"]
BackupStrategy = Literal["skip_duplicate", "merge", "replace_all"]

BACKUP_FORMATS = frozenset({"json", "csv", "html"})
BACKUP_STRATEGIES = frozenset({"skip_duplicate", "merge", "replace_all"})
NATIVE_JSON_FORMAT = "markhub-json"
NATIVE_JSON_VERSIONS = frozenset({1})


def validate_import_options(
    *, format: str | None, strategy: str | None
) -> tuple[str, str]:
    """Strict format/strategy enums (RQG-F008). Raises before any mutation."""
    fmt = (format or "json").strip().lower()
    strat = (strategy or "skip_duplicate").strip()
    if fmt not in BACKUP_FORMATS:
        raise api_error("validation", f"Unsupported format: {format}")
    if strat not in BACKUP_STRATEGIES:
        raise api_error("validation", f"Unsupported strategy: {strategy}")
    return fmt, strat


def _folder_path_map(folders: list[dict]) -> dict[str, list[str]]:
    """Build folder_id → path segments; system folders are omitted from paths."""
    by_id = {f["id"]: f for f in folders}
    cache: dict[str, list[str]] = {}

    def path_of(fid: str, seen: set[str] | None = None) -> list[str]:
        if fid in cache:
            return cache[fid]
        seen = seen or set()
        if fid in seen:
            return []
        seen.add(fid)
        f = by_id.get(fid)
        if not f or f.get("is_system"):
            cache[fid] = []
            return []
        parent = f.get("parent_id")
        parts = (path_of(parent, seen) if parent else []) + [f.get("name") or ""]
        parts = [p for p in parts if p]
        cache[fid] = parts
        return parts

    for f in folders:
        path_of(f["id"])
    return cache


def _tag_names(tags_field) -> list[str]:
    """Normalize export tags (objects or strings) to name list."""
    if not tags_field:
        return []
    out: list[str] = []
    for t in tags_field:
        if isinstance(t, dict):
            name = (t.get("name") or "").strip()
            if name:
                out.append(name)
        elif isinstance(t, str) and t.strip():
            out.append(t.strip())
    return out


def _tag_color_map(tags_field) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    if not isinstance(tags_field, list):
        return out
    for t in tags_field:
        if isinstance(t, dict):
            name = (t.get("name") or "").strip()
            if name:
                out[name] = t.get("color")
    return out


async def export_json(db: AsyncSession, user_id: str) -> dict:
    """Lossless native MarkHub JSON (RQG-BACKUP-001 / RQG-F003).

    Bookmarks include folder_path, sort_order, and tag names so importers do not
    depend on opaque folder IDs alone. Root tags[] carries colors for unassociated tags.
    """
    folders = await folder_svc.list_folders(db, user_id)
    # Full live set — no 1000-row cap (F-005)
    items = await bm_svc.iter_all_bookmarks(db, user_id)
    tags = list(
        (await db.execute(select(Tag).where(Tag.user_id == user_id))).scalars().all()
    )
    paths = _folder_path_map(folders)
    bookmarks = []
    for b in items:
        row = dict(b)
        row["folder_path"] = paths.get(b.get("folder_id") or "", [])
        # Dual form: string names for importers; keep full objects under tag_objects
        tag_objs = row.get("tags") or []
        row["tag_objects"] = tag_objs
        row["tags"] = _tag_names(tag_objs)
        row["is_favorite"] = bool(row.get("is_favorite", False))
        row["is_archived"] = bool(row.get("is_archived", False))
        row["sort_order"] = int(row.get("sort_order") or 0)
        bookmarks.append(row)
    return {
        "format": NATIVE_JSON_FORMAT,
        "version": 1,
        "exported_at": server_now().isoformat() + "Z",
        "folders": folders,
        "bookmarks": bookmarks,
        "tags": [tag_dict(t) for t in tags],
    }


def _csv_path_display(segments: list[str]) -> str:
    """Human-readable nested path using `>` (names may contain `/`)."""
    return " > ".join(segments)


async def export_csv(db: AsyncSession, user_id: str) -> str:
    """CSV with nested folder_path JSON + leaf folder display (RQG-F003)."""
    items = await bm_svc.iter_all_bookmarks(db, user_id)
    folders_list = await folder_svc.list_folders(db, user_id)
    folders = {f["id"]: f for f in folders_list}
    paths = _folder_path_map(folders_list)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "title",
            "url",
            "description",
            "folder",
            "folder_path",
            "folder_visibility",
            "tags",
            "visibility",
            "is_favorite",
            "is_archived",
            "sort_order",
        ]
    )
    for b in items:
        segs = paths.get(b["folder_id"] or "", [])
        folder_name = _csv_path_display(segs) if segs else (
            folders.get(b["folder_id"], {}).get("name", "") or ""
        )
        folder_vis = ""
        if segs and b.get("folder_id") in folders:
            folder_vis = folders[b["folder_id"]].get("visibility") or "private"
        tags = ",".join(t["name"] for t in b.get("tags") or [])
        w.writerow(
            [
                b["title"],
                b["url"],
                b.get("description") or "",
                folder_name,
                json.dumps(segs, ensure_ascii=False),
                folder_vis,
                tags,
                b.get("visibility", "private"),
                b.get("is_favorite", False),
                b.get("is_archived", False),
                int(b.get("sort_order") or 0),
            ]
        )
    return buf.getvalue()


async def export_html(db: AsyncSession, user_id: str) -> str:
    """Netscape HTML with MarkHub visibility/tag/order extensions (RQG-F003)."""
    folders = await folder_svc.list_folders(db, user_id)
    items = await bm_svc.iter_all_bookmarks(db, user_id)
    by_parent: dict[str | None, list] = {}
    for f in folders:
        by_parent.setdefault(f["parent_id"], []).append(f)
    by_folder: dict[str, list] = {}
    for b in items:
        by_folder.setdefault(b["folder_id"], []).append(b)

    lines = [
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
        "<!-- This is an automatically generated file by MarkHub. -->",
        "<TITLE>MarkHub Bookmarks</TITLE>",
        "<H1>MarkHub Bookmarks</H1>",
        "<DL><p>",
    ]

    def walk(parent_id: str | None, indent: int = 1) -> None:
        pad = "    " * indent
        for f in sorted(by_parent.get(parent_id, []), key=lambda x: x["sort_order"]):
            if f.get("is_system"):
                # Still walk children of system folders (inbox) without emitting H3
                for b in sorted(by_folder.get(f["id"], []), key=lambda x: x["sort_order"]):
                    _emit_bookmark(lines, pad, b)
                walk(f["id"], indent)
                continue
            vis = f.get("visibility") or "private"
            sort_o = int(f.get("sort_order") or 0)
            lines.append(
                f'{pad}<DT><H3 DATA-VISIBILITY="{escape(vis, quote=True)}" '
                f'DATA-SORT-ORDER="{sort_o}">{escape(f["name"])}</H3>'
            )
            lines.append(f"{pad}<DL><p>")
            for b in sorted(by_folder.get(f["id"], []), key=lambda x: x["sort_order"]):
                _emit_bookmark(lines, pad + "    ", b)
            walk(f["id"], indent + 1)
            lines.append(f"{pad}</DL><p>")

    walk(None)
    lines.append("</DL><p>")
    return "\n".join(lines)


def _emit_bookmark(lines: list[str], pad: str, b: dict) -> None:
    raw_url = str(b.get("url") or "")
    if raw_url.startswith("http://") or raw_url.startswith("https://"):
        href = escape(raw_url, quote=True)
    else:
        href = "#"
    title = escape(str(b.get("title") or raw_url or ""))
    tags = ",".join(_tag_names(b.get("tags")))
    vis = b.get("visibility") or "private"
    fav = "true" if b.get("is_favorite") else "false"
    arch = "true" if b.get("is_archived") else "false"
    sort_o = int(b.get("sort_order") or 0)
    attrs = [
        f'HREF="{href}"',
        f'DATA-VISIBILITY="{escape(str(vis), quote=True)}"',
        f'DATA-FAVORITE="{fav}"',
        f'DATA-ARCHIVED="{arch}"',
        f'DATA-SORT-ORDER="{sort_o}"',
    ]
    if tags:
        attrs.append(f'TAGS="{escape(tags, quote=True)}"')
    lines.append(f'{pad}<DT><A {" ".join(attrs)}>{title}</A>')


def _parse_netscape(html: str) -> tuple[list[dict], dict[tuple[str, ...], dict], list[str]]:
    """Structured HTML parser for Netscape bookmark files (F-020 / RQG-F003).

    Returns (bookmarks, folder_meta, errors).
    """
    errors: list[str] = []
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return _parse_netscape_regex(html)

    soup = BeautifulSoup(html, "lxml")
    bookmarks: list[dict] = []
    folder_meta: dict[tuple[str, ...], dict] = {}

    def walk_dl(dl, path: list[str]) -> None:
        if dl is None:
            return
        for dt in dl.find_all("dt", recursive=False):
            h3 = dt.find("h3", recursive=False)
            if h3 is None:
                h3 = dt.find("h3")
            a = dt.find("a", recursive=False)
            if a is None:
                a = dt.find("a")
            if h3 is not None:
                name = h3.get_text(strip=True)
                if not name:
                    continue
                new_path = path + [name]
                vis = (
                    h3.get("data-visibility")
                    or h3.get("visibility")
                    or "private"
                )
                if vis not in ("private", "unlisted", "public"):
                    vis = "private"
                sort_raw = h3.get("data-sort-order") or h3.get("sort_order")
                try:
                    sort_order = int(sort_raw) if sort_raw is not None else None
                except (TypeError, ValueError):
                    sort_order = None
                folder_meta[_encode_folder_path_key(new_path)] = {
                    "visibility": vis,
                    "sort_order": sort_order,
                    "name": name,
                }
                nested = dt.find("dl")
                if nested is None:
                    nested = dt.find_next_sibling("dl")
                walk_dl(nested, new_path)
            elif a is not None and a.get("href"):
                url = a["href"].strip()
                if not url or url == "#":
                    errors.append(
                        f"html anchor missing href near "
                        f"{(a.get_text(strip=True) or '')[:40]!r}"
                    )
                    continue
                title = a.get_text(strip=True) or url
                tags_raw = a.get("tags") or ""
                tags = [t.strip() for t in tags_raw.split(",") if t.strip()]
                vis = a.get("data-visibility") or a.get("visibility") or "private"
                if vis not in ("private", "unlisted", "public"):
                    vis = "private"
                fav = _truthy_flag(a.get("data-favorite") or a.get("favorite"))
                arch = _truthy_flag(a.get("data-archived") or a.get("archived"))
                sort_raw = a.get("data-sort-order") or a.get("sort_order")
                try:
                    sort_order = int(sort_raw) if sort_raw is not None else None
                except (TypeError, ValueError):
                    sort_order = None
                bookmarks.append(
                    {
                        "title": title,
                        "url": url,
                        "folder_path": list(path),
                        "tags": tags,
                        "visibility": vis,
                        "is_favorite": fav,
                        "is_archived": arch,
                        "sort_order": sort_order,
                    }
                )
        if not bookmarks and not any(dl.find_all("dt", recursive=False)):
            for a in dl.find_all("a", href=True):
                url = a["href"].strip()
                if not url or url == "#":
                    continue
                title = a.get_text(strip=True) or url
                bookmarks.append(
                    {"title": title, "url": url, "folder_path": list(path)}
                )

    root = soup.find("dl")
    if root is None:
        for a in soup.find_all("a", href=True):
            url = a["href"].strip()
            if not url or url == "#":
                continue
            title = a.get_text(strip=True) or url
            bookmarks.append({"title": title, "url": url, "folder_path": []})
        return bookmarks, folder_meta, errors

    walk_dl(root, [])
    if not bookmarks:
        for a in soup.find_all("a", href=True):
            url = a["href"].strip()
            if not url or url == "#":
                continue
            title = a.get_text(strip=True) or url
            path_acc: list[str] = []
            for parent in a.parents:
                if parent.name != "dl":
                    continue
                prev = parent.find_previous_sibling()
                if prev and prev.name == "dt":
                    h3 = prev.find("h3")
                    if h3:
                        path_acc.insert(0, h3.get_text(strip=True))
                elif prev and prev.name == "h3":
                    path_acc.insert(0, prev.get_text(strip=True))
            bookmarks.append(
                {"title": title, "url": url, "folder_path": path_acc}
            )
    return bookmarks, folder_meta, errors


def _parse_netscape_regex(
    html: str,
) -> tuple[list[dict], dict[tuple[str, ...], dict], list[str]]:
    """Legacy regex fallback for environments without BeautifulSoup."""
    bookmarks: list[dict] = []
    folder_meta: dict[tuple[str, ...], dict] = {}
    errors: list[str] = []
    stack: list[str] = []
    token_re = re.compile(
        r"<H3([^>]*)>(.*?)</H3>|</DL>|"
        r"<A\s+([^>]*HREF\s*=\s*[\"'][^\"']*[\"'][^>]*)>(.*?)</A>",
        re.I | re.S,
    )
    for m in token_re.finditer(html):
        if m.group(1) is not None and m.group(3) is None:
            attrs = m.group(1) or ""
            name = _decode(re.sub(r"<[^>]+>", "", m.group(2) or "").strip())
            if name:
                stack.append(name)
                vis_m = re.search(
                    r"(?:DATA-VISIBILITY|VISIBILITY)\s*=\s*[\"']([^\"']*)[\"']",
                    attrs,
                    re.I,
                )
                vis = vis_m.group(1) if vis_m else "private"
                if vis not in ("private", "unlisted", "public"):
                    vis = "private"
                folder_meta[_encode_folder_path_key(stack)] = {
                    "visibility": vis,
                    "name": name,
                }
        elif m.group(0).upper().startswith("</DL"):
            if stack:
                stack.pop()
        elif m.group(3) is not None:
            attrs = m.group(3) or ""
            href_m = re.search(r"HREF\s*=\s*[\"']([^\"']*)[\"']", attrs, re.I)
            url = _decode((href_m.group(1) if href_m else "").strip())
            title = _decode(re.sub(r"<[^>]+>", "", m.group(4) or "").strip()) or url
            if not url or url == "#":
                errors.append(f"html anchor missing href near {title[:40]!r}")
                continue
            tags_m = re.search(r"TAGS\s*=\s*[\"']([^\"']*)[\"']", attrs, re.I)
            tags = (
                [t.strip() for t in tags_m.group(1).split(",") if t.strip()]
                if tags_m
                else []
            )
            vis_m = re.search(
                r"(?:DATA-VISIBILITY|VISIBILITY)\s*=\s*[\"']([^\"']*)[\"']",
                attrs,
                re.I,
            )
            vis = vis_m.group(1) if vis_m else "private"
            if vis not in ("private", "unlisted", "public"):
                vis = "private"
            fav_m = re.search(
                r"(?:DATA-FAVORITE|FAVORITE)\s*=\s*[\"']([^\"']*)[\"']",
                attrs,
                re.I,
            )
            arch_m = re.search(
                r"(?:DATA-ARCHIVED|ARCHIVED)\s*=\s*[\"']([^\"']*)[\"']",
                attrs,
                re.I,
            )
            bookmarks.append(
                {
                    "title": title,
                    "url": url,
                    "folder_path": list(stack),
                    "tags": tags,
                    "visibility": vis,
                    "is_favorite": _truthy_flag(fav_m.group(1) if fav_m else None),
                    "is_archived": _truthy_flag(arch_m.group(1) if arch_m else None),
                }
            )
    return bookmarks, folder_meta, errors


def _decode(s: str) -> str:
    return (
        s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )


def _normalize_tag_names(tags) -> list[str]:
    if isinstance(tags, str):
        return [t.strip() for t in tags.split(",") if t.strip()]
    if not isinstance(tags, list):
        return []
    out: list[str] = []
    for t in tags:
        if isinstance(t, dict):
            name = (t.get("name") or "").strip()
            if name:
                out.append(name)
        elif isinstance(t, str) and t.strip():
            out.append(t.strip())
    return out


def _truthy_flag(value) -> bool:
    return value is True or value == 1 or value == "1" or value == "true" or value == "True"


def _optional_int(value) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _normalize_folder_export_rows(
    folders: list, errors: list[str] | None = None
) -> list[dict]:
    """Normalize folders[] rows from a native MarkHub JSON export."""
    if not isinstance(folders, list):
        return []
    normalized: list[dict] = []
    for i, f in enumerate(folders):
        if not isinstance(f, dict):
            if errors is not None:
                errors.append(f"folders[{i}]: invalid row")
            continue
        if not f.get("id"):
            if errors is not None:
                errors.append(f"folders[{i}]: missing id")
            continue
        vis = f.get("visibility")
        if vis not in ("private", "unlisted", "public"):
            vis = "private"
        normalized.append(
            {
                "id": f["id"],
                "parent_id": f.get("parent_id"),
                "name": f.get("name") or "",
                "is_system": bool(f.get("is_system")),
                "visibility": vis,
                "sort_order": _optional_int(f.get("sort_order")),
            }
        )
    return normalized


def _folder_paths_from_export(folders: list) -> dict[str, list[str]]:
    """Resolve folder_id → path when native export embeds folders[] without folder_path."""
    return _folder_path_map(_normalize_folder_export_rows(folders))


def _encode_folder_path_key(segments: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    """Unambiguous path key: segment tuple (names may contain `/`)."""
    return tuple(str(s) for s in segments)


def _folder_path_meta_from_export(folders: list) -> dict[tuple[str, ...], dict]:
    """Map segment-tuple path key → folder metadata (path-based; may collide)."""
    rows = _normalize_folder_export_rows(folders)
    paths = _folder_path_map(rows)
    by_id = {f["id"]: f for f in rows}
    meta: dict[tuple[str, ...], dict] = {}
    for fid, segs in paths.items():
        if not segs:
            continue
        key = _encode_folder_path_key(segs)
        f = by_id.get(fid) or {}
        meta[key] = {
            "visibility": f.get("visibility") or "private",
            "sort_order": f.get("sort_order"),
            "export_id": fid,
            "parent_export_id": f.get("parent_id"),
            "name": f.get("name") or "",
            "is_system": bool(f.get("is_system")),
        }
    return meta


def _folder_identity_meta_from_export(folders: list) -> dict[str, dict]:
    """Identity-preserving folder metadata keyed by export id (RQG-F003)."""
    rows = _normalize_folder_export_rows(folders)
    meta: dict[str, dict] = {}
    for f in rows:
        if f.get("is_system"):
            continue
        meta[f["id"]] = {
            "visibility": f.get("visibility") or "private",
            "sort_order": f.get("sort_order"),
            "export_id": f["id"],
            "parent_export_id": f.get("parent_id"),
            "name": f.get("name") or "",
            "is_system": False,
        }
    return meta


def _parse_csv(
    text: str,
) -> tuple[list[dict], dict[tuple[str, ...], dict], list[str]]:
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        return [], {}, ["empty csv"]
    fields = {h.strip().lower(): h for h in reader.fieldnames if h}
    if "title" not in fields or "url" not in fields:
        # DictReader already lowercases? keep flexible
        lower_set = {h.strip().lower() for h in reader.fieldnames if h}
        if "title" not in lower_set or "url" not in lower_set:
            return [], {}, ["CSV must include title and url columns"]

    out: list[dict] = []
    folder_meta: dict[tuple[str, ...], dict] = {}
    errors: list[str] = []
    for i, row in enumerate(reader, start=2):
        # normalize keys to lower
        nrow = {(k or "").strip().lower(): v for k, v in row.items()}
        url = (nrow.get("url") or "").strip()
        if not url:
            errors.append(f"row {i}: missing url")
            continue
        folder_path: list[str] = []
        folder_path_raw = (nrow.get("folder_path") or "").strip()
        if folder_path_raw:
            try:
                parsed = json.loads(folder_path_raw)
                if not isinstance(parsed, list):
                    errors.append(f"row {i}: folder_path must be a JSON array")
                    continue
                folder_path = [str(p) for p in parsed if str(p)]
            except json.JSONDecodeError:
                errors.append(f"row {i}: invalid folder_path JSON")
                continue
        else:
            folder = (nrow.get("folder") or nrow.get("category") or "").strip()
            if folder:
                # Prefer `>` nesting; also accept / and \ for foreign CSVs
                folder_path = [
                    p.strip()
                    for p in re.split(r">|[/\\]", folder)
                    if p.strip()
                ]
        fvis = (nrow.get("folder_visibility") or "").strip()
        if folder_path and fvis in ("private", "unlisted", "public"):
            folder_meta[_encode_folder_path_key(folder_path)] = {
                "visibility": fvis,
                "name": folder_path[-1],
            }
        tags = [t.strip() for t in (nrow.get("tags") or "").split(",") if t.strip()]
        out.append(
            {
                "title": (nrow.get("title") or url).strip(),
                "url": url,
                "description": nrow.get("description"),
                "folder_path": folder_path,
                "tags": tags,
                "visibility": nrow.get("visibility") or "private",
                "is_favorite": _truthy_flag(nrow.get("is_favorite")),
                "is_archived": _truthy_flag(nrow.get("is_archived")),
                "sort_order": _optional_int(nrow.get("sort_order")),
            }
        )
    return out, folder_meta, errors


def _parse_json(
    text: str,
) -> tuple[
    list[dict],
    dict[tuple[str, ...], dict],
    dict[str, dict],
    list[dict],
    list[str],
]:
    """Parse native/foreign JSON into bookmarks + folder/tag metadata (RQG-F003/F008)."""
    errors: list[str] = []
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return [], {}, {}, [], ["invalid json"]

    if isinstance(data, dict) and data.get("format") is not None:
        fmt = str(data.get("format"))
        if fmt not in (NATIVE_JSON_FORMAT, "litemark-json"):
            return [], {}, {}, [], [f"unsupported json format: {fmt}"]
        if fmt == NATIVE_JSON_FORMAT:
            if data.get("version") is None:
                return [], {}, {}, [], ["native markhub-json requires version"]
            try:
                ver = int(data["version"])
            except (TypeError, ValueError):
                return [], {}, {}, [], [
                    f"unsupported native json version: {data.get('version')}"
                ]
            if ver not in NATIVE_JSON_VERSIONS:
                return [], {}, {}, [], [
                    f"unsupported native json version: {data.get('version')}"
                ]

    items = data if isinstance(data, list) else (data.get("bookmarks") or [])
    if not isinstance(items, list):
        return [], {}, {}, [], ["bookmarks must be an array"]

    id_paths: dict[str, list[str]] = {}
    folder_meta: dict[tuple[str, ...], dict] = {}
    folder_by_export_id: dict[str, dict] = {}
    if isinstance(data, dict) and data.get("folders"):
        raw_folders = data.get("folders") or []
        _normalize_folder_export_rows(raw_folders, errors)
        id_paths = _folder_paths_from_export(raw_folders)
        folder_meta = _folder_path_meta_from_export(raw_folders)
        folder_by_export_id = _folder_identity_meta_from_export(raw_folders)

    root_tags: list[dict] = []
    if isinstance(data, dict) and isinstance(data.get("tags"), list):
        for i, raw in enumerate(data["tags"]):
            if not isinstance(raw, dict):
                errors.append(f"tags[{i}]: invalid row")
                continue
            name = (raw.get("name") or "").strip()
            if not name:
                errors.append(f"tags[{i}]: missing name")
                continue
            root_tags.append(
                {
                    "name": name,
                    "color": raw.get("color"),
                    "export_id": raw.get("id"),
                }
            )

    out: list[dict] = []
    for i, o in enumerate(items):
        if not isinstance(o, dict):
            errors.append(f"bookmarks[{i}]: invalid row")
            continue
        url = (o.get("url") or "").strip()
        if not url:
            errors.append(f"bookmarks[{i}]: missing url")
            continue
        path = o.get("folder_path")
        export_folder_id: str | None = None
        if isinstance(path, list):
            folder_path = [str(p) for p in path]
        elif isinstance(path, str):
            folder_path = [p for p in path.split("/") if p]
        elif o.get("category"):
            folder_path = [str(o["category"])]
        elif o.get("folder_id") and str(o["folder_id"]) in id_paths:
            folder_path = id_paths[str(o["folder_id"])]
            export_folder_id = str(o["folder_id"])
        else:
            folder_path = []
        if o.get("folder_id") is not None and export_folder_id is None:
            export_folder_id = str(o["folder_id"])
        tags = _normalize_tag_names(o.get("tags"))
        tag_colors = _tag_color_map(o.get("tag_objects") or o.get("tags"))
        vis = o.get("visibility")
        if not vis and "visible" in o:
            vis = "public" if o["visible"] else "private"
        out.append(
            {
                "title": o.get("title") or url,
                "url": url,
                "description": o.get("description"),
                "folder_path": folder_path,
                "export_folder_id": export_folder_id,
                "tags": tags,
                "tag_colors": tag_colors,
                "visibility": vis or "private",
                "is_favorite": _truthy_flag(o.get("is_favorite")),
                "is_archived": _truthy_flag(o.get("is_archived")),
                "sort_order": _optional_int(o.get("sort_order")),
            }
        )
    return out, folder_meta, folder_by_export_id, root_tags, errors


async def _ensure_folder_path(
    db: AsyncSession,
    user_id: str,
    path: list[str],
    cache: dict[tuple[str, ...], str],
    path_meta: dict[tuple[str, ...], dict] | None = None,
) -> str:
    """Create/resolve nested folders, applying exported visibility/sort when present."""
    if not path:
        return await get_inbox_folder_id(db, user_id)
    parent: str | None = None
    key_parts: list[str] = []
    meta = path_meta or {}
    for name in path:
        key_parts.append(name)
        key = _encode_folder_path_key(key_parts)
        seg_meta = meta.get(key) or {}
        vis = seg_meta.get("visibility") if isinstance(seg_meta, dict) else None
        if vis not in ("private", "unlisted", "public"):
            vis = "private"
        sort_order = (
            seg_meta.get("sort_order") if isinstance(seg_meta, dict) else None
        )
        if key in cache:
            parent = cache[key]
            if key in meta:
                existing_cached = (
                    await db.execute(
                        select(Folder).where(
                            Folder.id == parent,
                            Folder.deleted_at.is_(None),
                        )
                    )
                ).scalar_one_or_none()
                if existing_cached and not existing_cached.is_system:
                    patch: dict[str, Any] = {}
                    if existing_cached.visibility != vis:
                        patch["visibility"] = vis
                    if sort_order is not None and existing_cached.sort_order != sort_order:
                        patch["sort_order"] = sort_order
                    if patch:
                        await folder_svc.update_folder(
                            db, user_id, existing_cached.id, patch
                        )
            continue
        existing = (
            await db.execute(
                select(Folder).where(
                    Folder.user_id == user_id,
                    Folder.parent_id == parent if parent else Folder.parent_id.is_(None),
                    Folder.name == name,
                    Folder.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if existing:
            if key in meta and not existing.is_system:
                patch = {}
                if existing.visibility != vis:
                    patch["visibility"] = vis
                if sort_order is not None and existing.sort_order != sort_order:
                    patch["sort_order"] = sort_order
                if patch:
                    await folder_svc.update_folder(db, user_id, existing.id, patch)
            parent = existing.id
        else:
            created = await folder_svc.create_folder(
                db,
                user_id,
                name,
                parent_id=parent,
                visibility=vis,
                sort_order=sort_order,
            )
            parent = created["id"]
        cache[key] = parent
    return parent  # type: ignore


async def _ensure_folders_by_identity(
    db: AsyncSession,
    user_id: str,
    folder_by_export_id: dict[str, dict],
) -> dict[str, str]:
    """Recreate folders by export id so same-parent same-name rows stay distinct (RQG-F003)."""
    id_map: dict[str, str] = {}
    if not folder_by_export_id:
        return id_map

    # Topological order: parents before children
    remaining = dict(folder_by_export_id)
    progress = True
    while remaining and progress:
        progress = False
        for export_id, meta in list(remaining.items()):
            parent_export = meta.get("parent_export_id")
            # Parent is system / missing → root
            if parent_export and parent_export in folder_by_export_id:
                if parent_export not in id_map:
                    continue
                parent_id: str | None = id_map[parent_export]
            else:
                parent_id = None
            name = (meta.get("name") or "").strip() or "Folder"
            vis = meta.get("visibility") or "private"
            if vis not in ("private", "unlisted", "public"):
                vis = "private"
            sort_order = meta.get("sort_order")
            created = await folder_svc.create_folder(
                db,
                user_id,
                name,
                parent_id=parent_id,
                visibility=vis,
                sort_order=sort_order,
            )
            id_map[export_id] = created["id"]
            del remaining[export_id]
            progress = True

    # Any cycle leftovers: create under root
    for export_id, meta in remaining.items():
        name = (meta.get("name") or "").strip() or "Folder"
        vis = meta.get("visibility") or "private"
        if vis not in ("private", "unlisted", "public"):
            vis = "private"
        created = await folder_svc.create_folder(
            db,
            user_id,
            name,
            parent_id=None,
            visibility=vis,
            sort_order=meta.get("sort_order"),
        )
        id_map[export_id] = created["id"]
    return id_map


async def _ensure_root_tags(
    db: AsyncSession,
    user_id: str,
    root_tags: list[dict],
    bookmark_tag_colors: dict[str, str | None],
) -> None:
    """Restore unassociated tags and colors (RQG-F003)."""
    colors = dict(bookmark_tag_colors)
    for t in root_tags:
        name = (t.get("name") or "").strip()
        if not name:
            continue
        if t.get("color") is not None:
            colors[name] = t.get("color")
        await tag_svc.create_tag(db, user_id, name, color=colors.get(name))

    # Apply colors for tags that already existed without color
    for name, color in colors.items():
        if color is None:
            continue
        existing = (
            await db.execute(
                select(Tag).where(Tag.user_id == user_id, Tag.name == name)
            )
        ).scalar_one_or_none()
        if existing and existing.color != color:
            await tag_svc.update_tag(db, user_id, existing.id, color=color)


async def import_data(
    db: AsyncSession,
    user_id: str,
    *,
    content: str,
    format: str,
    strategy: str = "skip_duplicate",
    confirm_replace: bool = False,
) -> dict:
    fmt, strat = validate_import_options(format=format, strategy=strategy)

    if strat == "replace_all" and not confirm_replace:
        raise api_error("confirm_required", "replace_all requires confirm_replace=true")

    folder_meta: dict[tuple[str, ...], dict] = {}
    folder_by_export_id: dict[str, dict] = {}
    root_tags: list[dict] = []
    parse_errors: list[str] = []

    if fmt == "html":
        items, folder_meta, parse_errors = _parse_netscape(content)
    elif fmt == "csv":
        items, folder_meta, parse_errors = _parse_csv(content)
    elif fmt == "json":
        items, folder_meta, folder_by_export_id, root_tags, parse_errors = _parse_json(
            content
        )
    else:
        raise api_error("validation", f"Unsupported format: {format}")

    # Strict: any parse error rejects before mutation (RQG-F008)
    if parse_errors:
        raise api_error("validation", "; ".join(parse_errors))

    if strat == "replace_all":
        # Route every deletion through Domain Service + op_log (F-013)
        bms = (
            await db.execute(
                select(Bookmark).where(
                    Bookmark.user_id == user_id, Bookmark.deleted_at.is_(None)
                )
            )
        ).scalars().all()
        for b in bms:
            await bm_svc.delete_bookmark(db, user_id, b.id)
        folders = (
            await db.execute(
                select(Folder).where(
                    Folder.user_id == user_id,
                    Folder.deleted_at.is_(None),
                    Folder.is_system == False,  # noqa: E712
                )
            )
        ).scalars().all()

        def _depth_of(f: Folder) -> int:
            d = 0
            cur = f
            seen: set[str] = set()
            while cur and cur.parent_id and cur.parent_id not in seen:
                seen.add(cur.parent_id)
                d += 1
                parent = next((x for x in folders if x.id == cur.parent_id), None)
                if not parent:
                    break
                cur = parent
            return d

        for f in sorted(folders, key=_depth_of, reverse=True):
            live = (
                await db.execute(
                    select(Folder).where(
                        Folder.id == f.id,
                        Folder.deleted_at.is_(None),
                    )
                )
            ).scalar_one_or_none()
            if live and not live.is_system:
                await folder_svc.delete_folder(
                    db, user_id, f.id, mode="cascade_soft_delete"
                )

    live = (
        await db.execute(
            select(Bookmark).where(
                Bookmark.user_id == user_id, Bookmark.deleted_at.is_(None)
            )
        )
    ).scalars().all()
    by_norm: dict[str, list[Bookmark]] = {}
    for b in live:
        by_norm.setdefault(b.url_normalized, []).append(b)

    folder_cache: dict[tuple[str, ...], str] = {}
    export_id_map: dict[str, str] = {}
    created = skipped = merged = 0

    # Identity-preserving folder restore for native JSON replace_all
    # (handles same-parent same-name folders). Other strategies resolve by path
    # so skip/merge do not spawn duplicate trees on re-import.
    if folder_by_export_id and strat == "replace_all":
        export_id_map = await _ensure_folders_by_identity(
            db, user_id, folder_by_export_id
        )
    elif folder_meta:
        for path_key in sorted(folder_meta.keys(), key=lambda k: len(k)):
            segs = list(path_key)
            if segs:
                await _ensure_folder_path(
                    db, user_id, segs, folder_cache, folder_meta
                )

    # Aggregate tag colors from bookmarks + root tags
    tag_colors: dict[str, str | None] = {}
    for item in items:
        for name, color in (item.get("tag_colors") or {}).items():
            if color is not None:
                tag_colors[name] = color
    await _ensure_root_tags(db, user_id, root_tags, tag_colors)

    for item in items:
        url = item["url"]
        norm = normalize_url(url)
        hits = by_norm.get(norm, [])

        export_fid = item.get("export_folder_id")
        if export_fid and export_fid in export_id_map:
            folder_id = export_id_map[export_fid]
        else:
            folder_id = await _ensure_folder_path(
                db,
                user_id,
                item.get("folder_path") or [],
                folder_cache,
                folder_meta,
            )

        if hits and strat == "skip_duplicate":
            skipped += 1
            continue

        sort_order = item.get("sort_order")
        if hits and strat == "merge":
            chosen = None
            for h in hits:
                if h.folder_id == folder_id:
                    chosen = h
                    break
            if chosen is None:
                chosen = sorted(hits, key=lambda x: x.created_at or server_now())[0]
            patch = {
                "title": item.get("title"),
                "description": item.get("description"),
                "folder_id": folder_id,
                "tags": item.get("tags"),
                "visibility": item.get("visibility"),
                "is_favorite": bool(item.get("is_favorite", False)),
                "is_archived": bool(item.get("is_archived", False)),
            }
            if sort_order is not None:
                patch["sort_order"] = sort_order
            await bm_svc.update_bookmark(db, user_id, chosen.id, patch)
            merged += 1
            continue

        create_data: dict[str, Any] = {
            "title": item.get("title"),
            "url": url,
            "description": item.get("description"),
            "folder_id": folder_id,
            "tags": item.get("tags") or [],
            "visibility": item.get("visibility") or "private",
            "is_favorite": bool(item.get("is_favorite", False)),
            "is_archived": bool(item.get("is_archived", False)),
        }
        if sort_order is not None:
            create_data["sort_order"] = sort_order
        created_bm = await bm_svc.create_bookmark(db, user_id, create_data)
        by_norm.setdefault(norm, []).append(
            (
                await db.execute(select(Bookmark).where(Bookmark.id == created_bm["id"]))
            ).scalar_one()
        )
        created += 1

    return {
        "ok": True,
        "strategy": strat,
        "created": created,
        "skipped": skipped,
        "merged": merged,
        "total_input": len(items),
    }
