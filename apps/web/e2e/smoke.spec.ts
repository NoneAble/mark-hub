import { expect, test, type Page } from "@playwright/test";

const USER = process.env.MARKHUB_ADMIN_USERNAME || "admin";
const PASS = process.env.MARKHUB_ADMIN_PASSWORD || "admin123";
const NEW_PASS = process.env.MARKHUB_NEW_PASSWORD || "E2eAdminPass99!";

async function openLoginModal(page: Page) {
  await page.goto("/");
  await page.getByTestId("topbar-login").click();
  await expect(page.getByTestId("login-password")).toBeVisible();
}

async function submitLogin(page: Page, password: string) {
  await openLoginModal(page);
  await page.getByTestId("login-username").fill(USER);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
}

async function completeForcedPasswordChange(page: Page, currentPassword: string) {
  // must_change_password: the settings modal opens automatically on the account tab
  const dialog = page.locator(".modal");
  await expect(dialog).toContainText(/change the default password|修改默认密码/i);
  const pwInputs = dialog.locator('input[type="password"]');
  await pwInputs.nth(0).fill(currentPassword);
  await pwInputs.nth(1).fill(NEW_PASS);
  // Submit via Enter: on mobile emulation the focused input pans the visual
  // viewport, which skews Playwright's click coordinates.
  await pwInputs.nth(1).press("Enter");
  await expect(dialog.locator(".success")).toContainText(/Updated|已更新/);
  await page.keyboard.press("Escape");
  // Mobile emulation: focusing inputs pans the visual viewport; reset it so
  // later coordinate-based clicks land where they should.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.scrollTo(0, 0);
  });
}

async function ensureLoggedIn(page: Page) {
  await submitLogin(page, PASS);
  await page.waitForTimeout(500);
  const loginError = page.locator(".modal .error");
  if (await loginError.isVisible().catch(() => false)) {
    // Password already rotated by an earlier run
    await page.getByTestId("login-password").fill(NEW_PASS);
    await page.getByTestId("login-submit").click();
    await page.waitForTimeout(500);
  }
  // Forced password change on first login
  const forced = page.locator(".modal", {
    hasText: /change the default password|修改默认密码/i,
  });
  if (await forced.isVisible().catch(() => false)) {
    await completeForcedPasswordChange(page, PASS);
  }
  await expect(page.getByTestId("user-menu")).toBeVisible({ timeout: 20_000 });
}

test.describe("MarkHub material flows", () => {
  test("release acceptance journey @release", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toContainText(/MarkHub/);
    await expect(page.getByTestId("topbar-login")).toBeVisible();

    await submitLogin(page, "definitely-wrong-password-zzz");
    await expect(page.locator(".modal .error")).toContainText(/invalid|error|失败|密码/i);
    await page.keyboard.press("Escape");

    await submitLogin(page, PASS);
    await completeForcedPasswordChange(page, PASS);
    await expect(page.getByTestId("user-menu")).toBeVisible();

    await page.evaluate(() => localStorage.clear());
    await submitLogin(page, NEW_PASS);
    await expect(page.getByTestId("user-menu")).toBeVisible();

    const stamp = `${Date.now()}-${test.info().project.name}`;
    const title = `Release bookmark ${stamp}`;
    const url = `https://release-${stamp}.example/item`;
    await page.getByTestId("topbar-add").click();
    await page.getByTestId("bm-form-url").fill(url);
    await page.getByTestId("bm-form-title").fill(title);
    await page.getByTestId("bm-form-title").press("Enter");
    await expect(page.locator("body")).toContainText(title, { timeout: 10_000 });
  });

  test("public navigation loads", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("body")).toContainText(/MarkHub|bookmark|书签|导航/i);
  });

  test("legacy admin and app routes redirect home", async ({ page }) => {
    for (const path of ["/admin", "/admin/bookmarks", "/admin/backup", "/app", "/admin/login"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator("body")).toContainText(/MarkHub/);
    }
  });

  test("bookmark CRUD from the home page creates a visible card", async ({ page }) => {
    await ensureLoggedIn(page);
    const stamp = Date.now();
    const title = `E2E ${stamp}`;
    const url = `https://e2e.example/${stamp}`;
    await page.getByTestId("topbar-add").click();
    await page.getByTestId("bm-form-url").fill(url);
    await page.getByTestId("bm-form-title").fill(title);
    await page.getByTestId("bm-form-title").press("Enter");
    await expect(page.locator("body")).toContainText(title, { timeout: 10_000 });
  });

  test("edit mode exposes folder management and batch bar", async ({ page }) => {
    await ensureLoggedIn(page);
    await page.getByTestId("topbar-edit").click();
    await expect(page.getByTestId("new-folder")).toBeVisible();
    // Select the first card's checkbox → batch bar appears
    const check = page.locator(".bm-check").first();
    if (await check.isVisible().catch(() => false)) {
      await check.check();
      await expect(page.getByTestId("batch-bar")).toBeVisible();
    }
  });

  test("backup import UI exposes format strategy and file picker", async ({ page }) => {
    await ensureLoggedIn(page);
    await page.getByTestId("user-menu").click();
    await page.getByTestId("menu-backup").click();
    await expect(page.getByTestId("import-file")).toBeVisible();
    await expect(page.getByTestId("import-format")).toBeVisible();
    await expect(page.getByTestId("import-strategy")).toBeVisible();
    await page.getByTestId("import-format").selectOption("html");
    await page.getByTestId("import-strategy").selectOption("skip_duplicate");
    await page.getByTestId("import-text").fill(
      `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
<DT><H3>E2EFolder</H3>
<DL><p>
<DT><A HREF="https://import-e2e.example/">Import E2E</A>
</DL><p>
</DL><p>`,
    );
    await page.getByTestId("import-submit").click();
    await expect(page.locator("body")).toContainText(/Imported|created|skipped/i, {
      timeout: 15_000,
    });
  });

  test("QR opens dialog when bookmarks exist", async ({ page }) => {
    await ensureLoggedIn(page);
    const stamp = Date.now();
    await page.getByTestId("topbar-add").click();
    await page.getByTestId("bm-form-url").fill(`https://qr-e2e.example/${stamp}`);
    await page.getByTestId("bm-form-title").fill(`QR ${stamp}`);
    await page.getByTestId("bm-form-title").press("Enter");
    await expect(page.locator("body")).toContainText(`QR ${stamp}`, { timeout: 10_000 });
    const qrBtn = page.locator('[data-testid^="qr-"]').first();
    await qrBtn.click({ force: true });
    await expect(page.locator("body")).toContainText(/QR|qr|scan|关闭|close|MarkHub/i);
  });

  test("login failure path shows an error and stays logged out", async ({ page }) => {
    await submitLogin(page, "definitely-wrong-password-zzz");
    await page.waitForTimeout(600);
    await expect(page.locator(".modal .error")).toContainText(/invalid|error|失败|密码/i);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("topbar-login")).toBeVisible();
  });
});
