"""URL normalization — mirrors packages/core normalizeUrl."""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

TRACKING = re.compile(r"^(utm_|spm$|fbclid$|gclid$|mc_eid$|mc_cid$|_ga$|yclid$|msclkid$)", re.I)


def normalize_url(raw: str) -> str:
    trimmed = (raw or "").strip()
    if not trimmed:
        return ""
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", trimmed):
        trimmed = "https://" + trimmed
    try:
        p = urlparse(trimmed)
    except Exception:
        return trimmed.lower()
    if p.scheme not in ("http", "https"):
        return trimmed.lower()
    netloc = p.hostname.lower() if p.hostname else ""
    if p.port and not ((p.scheme == "http" and p.port == 80) or (p.scheme == "https" and p.port == 443)):
        netloc = f"{netloc}:{p.port}"
    path = p.path or "/"
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
    # Preserve original query key/value case (only drop tracking params).
    qs = [
        (k, v)
        for k, v in parse_qsl(p.query, keep_blank_values=True)
        if not TRACKING.match(k)
    ]
    query = urlencode(qs, doseq=True)
    # KD appendix A: lowercase scheme + host only; preserve path/query case.
    return urlunparse((p.scheme.lower(), netloc, path, "", query, ""))


def is_valid_http_url(raw: str) -> bool:
    try:
        s = raw if "://" in raw else f"https://{raw}"
        p = urlparse(s)
        return p.scheme in ("http", "https") and bool(p.netloc)
    except Exception:
        return False
