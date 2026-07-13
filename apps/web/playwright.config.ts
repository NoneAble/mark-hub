import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.MARKHUB_E2E_PORT || 4173);
const BASE = process.env.MARKHUB_E2E_BASE_URL || `http://127.0.0.1:${PORT}`;
const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = process.env.MARKHUB_E2E_OUTPUT_ROOT
  ? path.resolve(process.env.MARKHUB_E2E_OUTPUT_ROOT)
  : fs.mkdtempSync(path.join(os.tmpdir(), "markhub-playwright-"));

/** Prefer project-local full Chromium over headless-shell (sandbox SEGV). */
function resolveChromiumExecutable(): string | undefined {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.resolve(CONFIG_DIR, "../../.pw-browsers"),
  ].filter(Boolean) as string[];
  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root).filter((d) => d.startsWith("chromium-"));
      entries.sort();
      const latest = entries[entries.length - 1];
      if (!latest) continue;
      const candidates = [
        path.join(root, latest, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        path.join(root, latest, "chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        path.join(root, latest, "chrome-linux", "chrome"),
        path.join(root, latest, "chrome-win", "chrome.exe"),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) return c;
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

const chromiumPath = resolveChromiumExecutable();

/**
 * Browser E2E harness (R4-F001 / F009).
 *
 * Expects a running MarkHub stack (API + SPA) at MARKHUB_E2E_BASE_URL,
 * or use the root package script which starts owned API and temporary SPA servers.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  outputDir: path.join(OUTPUT_ROOT, "test-results"),
  reporter: [["list"], ["html", { open: "never", outputFolder: path.join(OUTPUT_ROOT, "report") }]],
  use: {
    baseURL: BASE,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
    },
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: undefined,
        headless: true,
      },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
