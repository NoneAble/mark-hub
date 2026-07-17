/** Theme helpers for the workbench shell. */

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
