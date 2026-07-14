/** Theme / accent helpers shared across settings + shell. */

const ACCENT_HUE: Record<string, number> = {
  blue: 260,
  green: 160,
  orange: 55,
  purple: 300,
  default: 260,
  linear: 250,
  emerald: 160,
  rose: 20,
  amber: 80,
};

export function applyAccentHue(hue: number) {
  const r = document.documentElement.style;
  r.setProperty("--accent", `oklch(0.55 0.18 ${hue})`);
  r.setProperty("--accent-weak", `oklch(0.95 0.02 ${hue})`);
  r.setProperty("--accent-text", `oklch(0.45 0.16 ${hue})`);
  if (document.documentElement.classList.contains("dark")) {
    r.setProperty("--accent", `oklch(0.62 0.16 ${hue})`);
    r.setProperty("--accent-weak", `oklch(0.3 0.06 ${hue})`);
    r.setProperty("--accent-text", `oklch(0.78 0.1 ${hue})`);
  }
}

export function applyAccentKey(key: string) {
  const hue = ACCENT_HUE[key] ?? 260;
  applyAccentHue(hue);
}

export function applyThemeMode(theme: string | undefined | null) {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", !!dark);
  // re-apply accent under new theme if set
  const accent = document.documentElement.style.getPropertyValue("--accent");
  if (!accent) return;
}

export function toggleTheme(): "light" | "dark" {
  const isDark = document.documentElement.classList.contains("dark");
  const next = isDark ? "light" : "dark";
  document.documentElement.classList.toggle("dark", next === "dark");
  localStorage.setItem("markhub_theme", next);
  return next;
}

export function initThemeFromStorage() {
  const saved = localStorage.getItem("markhub_theme");
  if (saved === "dark" || saved === "light") {
    document.documentElement.classList.toggle("dark", saved === "dark");
    return;
  }
  if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
    document.documentElement.classList.add("dark");
  }
}

export function currentTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}
