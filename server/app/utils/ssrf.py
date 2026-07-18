"""SSRF guards: resolve hosts, pin IPs, reject private ranges, validate redirect hops."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urljoin, urlparse, urlunparse

import httpx

BLOCKED_HOSTS = {"localhost", "metadata.google.internal", "metadata", "metadata.google"}


def _ip_is_blocked(ip: ipaddress._BaseAddress) -> bool:
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
        return True
    if ip.is_multicast or ip.is_unspecified:
        return True
    if isinstance(ip, ipaddress.IPv4Address):
        if ip in ipaddress.ip_network("169.254.0.0/16"):
            return True
        if ip in ipaddress.ip_network("100.64.0.0/10"):
            return True
        if ip in ipaddress.ip_network("0.0.0.0/8"):
            return True
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return _ip_is_blocked(ip.ipv4_mapped)
    return False


def is_blocked_host(hostname: str) -> bool:
    h = (hostname or "").lower().rstrip(".")
    if not h:
        return True
    if h in BLOCKED_HOSTS:
        return True
    if h.endswith(".localhost") or h.endswith(".local") or h.endswith(".internal"):
        return True
    try:
        ip = ipaddress.ip_address(h)
        return _ip_is_blocked(ip)
    except ValueError:
        pass
    if h.startswith("[") and h.endswith("]"):
        try:
            ip = ipaddress.ip_address(h[1:-1])
            return _ip_is_blocked(ip)
        except ValueError:
            return True
    return False


def resolve_public_ips(hostname: str) -> tuple[list[str], str]:
    """Resolve hostname and return public IP strings, or empty + reason."""
    h = (hostname or "").lower().rstrip(".")
    if is_blocked_host(h):
        return [], "blocked_host"
    # Literal IP
    try:
        ip = ipaddress.ip_address(h)
        if _ip_is_blocked(ip):
            return [], "blocked_resolved_ip"
        return [str(ip)], ""
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(h, None)
    except socket.gaierror:
        return [], "dns_resolution_failed"
    if not infos:
        return [], "dns_resolution_failed"
    public: list[str] = []
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if _ip_is_blocked(ip):
            return [], "blocked_resolved_ip"
        if str(ip) not in public:
            public.append(str(ip))
    if not public:
        return [], "dns_resolution_failed"
    return public, ""


def resolve_and_check_host(hostname: str) -> tuple[bool, str]:
    ips, reason = resolve_public_ips(hostname)
    if not ips:
        return False, reason
    return True, ""


def assert_safe_url(raw: str) -> tuple[bool, str]:
    try:
        p = urlparse(raw)
    except Exception:
        return False, "invalid_url"
    if p.scheme not in ("http", "https"):
        return False, "unsupported_protocol"
    host = p.hostname or ""
    if is_blocked_host(host):
        return False, "blocked_host"
    ok, reason = resolve_and_check_host(host)
    if not ok:
        return False, reason
    return True, ""


def pin_url_to_ip(raw: str) -> tuple[str, str, list[str]]:
    """
    Resolve hostname, reject private IPs, return (url_with_ip_host, original_host, ips).
    Connecting by IP + Host header closes the DNS-rebinding TOCTOU window (F-014).
    """
    p = urlparse(raw)
    host = p.hostname or ""
    ips, reason = resolve_public_ips(host)
    if not ips:
        raise ValueError(f"SSRF blocked: {reason}")
    # Prefer IPv4 for broader compatibility
    ip = next((i for i in ips if ":" not in i), ips[0])
    netloc = f"[{ip}]" if ":" in ip else ip
    if p.port:
        netloc = f"{netloc}:{p.port}"
    pinned = urlunparse((p.scheme, netloc, p.path or "/", p.params, p.query, ""))
    return pinned, host, ips


async def safe_fetch(
    url: str,
    *,
    method: str = "GET",
    timeout: float = 10.0,
    max_redirects: int = 5,
    headers: dict | None = None,
) -> httpx.Response:
    """
    Fetch URL with SSRF protection: resolve + pin IP (no second DNS lookup by
    the HTTP client), reject private ranges, and re-validate every redirect hop.
    """
    current = url
    last: httpx.Response | None = None
    base_headers = {"User-Agent": "MarkHub/0.1", **(headers or {})}

    # Disable automatic DNS by using pinned IP; still send original Host.
    async with httpx.AsyncClient(
        follow_redirects=False,
        timeout=timeout,
        # Do not use a transport that re-resolves hostnames independently.
    ) as client:
        for _ in range(max_redirects + 1):
            ok, reason = assert_safe_url(current)
            if not ok:
                raise ValueError(f"SSRF blocked: {reason}")
            pinned, original_host, _ips = pin_url_to_ip(current)
            req_headers = dict(base_headers)
            extensions: dict = {}
            if not _is_literal_ip(original_host):
                req_headers["Host"] = original_host
                # TLS: verify certificate against the original hostname (SNI),
                # not the pinned IP the socket connects to.
                if current.lower().startswith("https"):
                    extensions["sni_hostname"] = original_host
            last = await client.request(
                method if last is None else "GET",
                pinned,
                headers=req_headers,
                extensions=extensions,
            )
            if last.status_code in (301, 302, 303, 307, 308):
                loc = last.headers.get("location")
                if not loc:
                    break
                # Resolve relative redirects against original (hostname) URL, not pinned
                current = urljoin(current, loc)
                method = "GET" if last.status_code in (303,) else method
                continue
            return last
    if last is None:
        raise ValueError("SSRF blocked: empty response")
    return last


def _is_literal_ip(host: str) -> bool:
    h = host or ""
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    try:
        ipaddress.ip_address(h)
        return True
    except ValueError:
        return False
