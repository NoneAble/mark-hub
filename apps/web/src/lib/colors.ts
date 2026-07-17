/** Deterministic brand colors for letter avatars (matches prototype mock). */

const KNOWN: Record<string, { color: string; letter: string }> = {
  "github.com": { color: "#24292f", letter: "G" },
  "developer.mozilla.org": { color: "#0b5fff", letter: "M" },
  "stackoverflow.com": { color: "#f26207", letter: "S" },
  "vercel.com": { color: "#111111", letter: "V" },
  "react.dev": { color: "#087ea4", letter: "R" },
  "vitejs.dev": { color: "#646cff", letter: "V" },
  "hub.docker.com": { color: "#2496ed", letter: "D" },
  "dash.cloudflare.com": { color: "#f38020", letter: "C" },
  "figma.com": { color: "#a259ff", letter: "F" },
  "dribbble.com": { color: "#ea4c89", letter: "D" },
  "coolors.co": { color: "#0acf83", letter: "C" },
  "producthunt.com": { color: "#ff6154", letter: "P" },
  "arxiv.org": { color: "#b31b1b", letter: "A" },
  "huggingface.co": { color: "#ff9d00", letter: "H" },
  "claude.ai": { color: "#d97757", letter: "C" },
  "platform.openai.com": { color: "#10a37f", letter: "O" },
  "news.ycombinator.com": { color: "#ff6600", letter: "H" },
  "ruanyifeng.com": { color: "#2a6fdb", letter: "R" },
};

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] || url;
  }
}

export function brandOf(urlOrHost: string): { color: string; letter: string; domain: string } {
  const domain = hostnameOf(urlOrHost);
  const known = KNOWN[domain];
  if (known) return { ...known, domain };
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
  }
  const hues = [210, 260, 300, 160, 20, 40, 190, 340];
  const hue = hues[hash % hues.length];
  const letter = (domain[0] || "?").toUpperCase();
  return { color: `hsl(${hue} 42% 42%)`, letter, domain };
}

export function visIcon(visibility?: string | null): string {
  if (visibility === "public") return "🌐";
  if (visibility === "unlisted") return "🔗";
  return "🔒";
}

