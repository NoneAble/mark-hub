/**
 * Normalize URLs for duplicate detection (Smart-Bookmark aligned, KD appendix A).
 *
 * 1. Parse URL; only http/https
 * 2. Lowercase host
 * 3. Strip hash
 * 4. Drop tracking query params (utm_*, spm, fbclid, gclid, ...)
 * 5. Drop default ports
 * 6. Strip trailing slash (except root path)
 */

const TRACKING_PARAM =
  /^(utm_|spm$|fbclid$|gclid$|mc_eid$|mc_cid$|_ga$|yclid$|msclkid$)/i;

export function normalizeUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";

  let input = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
    input = `https://${input}`;
  }

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return trimmed.toLowerCase();
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return trimmed.toLowerCase();
  }

  u.hash = "";
  u.hostname = u.hostname.toLowerCase();

  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }

  const keep = new URLSearchParams();
  // Preserve original order of non-tracking params
  for (const [k, v] of u.searchParams.entries()) {
    if (!TRACKING_PARAM.test(k)) {
      keep.append(k, v);
    }
  }
  const qs = keep.toString();
  u.search = qs ? `?${qs}` : "";

  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }

  // KD appendix A: lowercase scheme + host only; preserve path/query case.
  // URL.toString() may re-encode; rebuild to keep path/query casing stable.
  const scheme = u.protocol.toLowerCase(); // includes trailing ':'
  const host = u.hostname.toLowerCase();
  const port = u.port ? `:${u.port}` : "";
  const path = u.pathname || "/";
  const search = u.search || "";
  return `${scheme}//${host}${port}${path}${search}`;
}
