/** Local letter-avatar favicon — never phones home (R4-F010). */
export function faviconOf(url: string, size = 32): string {
  let host = "?";
  try {
    host = new URL(url).hostname.replace(/^www\./, "") || "?";
  } catch {
    host = url.slice(0, 1) || "?";
  }
  const letter = (host[0] || "?").toUpperCase();
  // Deterministic soft hue from hostname
  let hash = 0;
  for (let i = 0; i < host.length; i++) {
    hash = (hash * 31 + host.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="100%" height="100%" rx="${Math.max(2, size / 6)}" fill="hsl(${hue} 42% 42%)"/>
  <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle"
    fill="#fff" font-family="system-ui,sans-serif" font-size="${Math.round(size * 0.55)}"
    font-weight="600">${letter}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
