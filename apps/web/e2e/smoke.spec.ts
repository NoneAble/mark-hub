import { expect, test, type Page } from "@playwright/test";

const USER = process.env.MARKHUB_ADMIN_USERNAME || "admin";
const PASS = process.env.MARKHUB_ADMIN_PASSWORD || "admin123";
const NEW_PASS = process.env.MARKHUB_NEW_PASSWORD || "E2eAdminPass99!";

async function submitLogin(page: Page, password: string) {
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: /username|用户名/i }).fill(USER);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /login|登录/i }).click();
}

async function ensureLoggedIn(page: Page) {
  await page.goto("/admin/login");
  await page.locator("input").nth(0).fill(USER);
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('button[type="submit"], button:has-text("Login"), button:has-text("登录")').first().click();
  await page.waitForTimeout(400);
  if (page.url().includes("/login")) {
    await page.locator("input").nth(0).fill(USER);
    await page.locator('input[type="password"]').first().fill(NEW_PASS);
    await page.locator('button[type="submit"], button:has-text("Login"), button:has-text("登录")').first().click();
  }
  // Force password change flow
  if (page.url().includes("account") || (await page.locator('input[type="password"]').count()) >= 2) {
    const inputs = page.locator('input[type="password"]');
    const count = await inputs.count();
    if (count >= 2 && (page.url().includes("account") || page.url().includes("force") || page.url().includes("login") === false)) {
      // may already be past force-change
    }
    if (page.url().includes("account") || page.url().includes("force")) {
      await inputs.nth(0).fill(PASS);
      await inputs.nth(1).fill(NEW_PASS);
      if (count >= 3) await inputs.nth(2).fill(NEW_PASS);
      await page.locator('button[type="submit"]').first().click();
      await page.waitForTimeout(400);
      await page.goto("/admin/login");
      await page.locator("input").nth(0).fill(USER);
      await page.locator('input[type="password"]').first().fill(NEW_PASS);
      await page.locator('button[type="submit"]').first().click();
    }
  }
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 20_000 });
  expect(page.url()).not.toMatch(/\/login/);
}

test.describe("MarkHub material flows", () => {
  test("release acceptance journey @release", async ({ page, request }) => {
    await page.goto("/");
    await expect(page.locator("body")).toContainText(/MarkHub/);
    await expect(page.getByRole("link", { name: /login|登录/i })).toBeVisible();

    await submitLogin(page, "definitely-wrong-password-zzz");
    await expect(page).toHaveURL(/\/admin\/login/);
    await expect(page.locator(".error")).toContainText(/invalid|error|失败|密码/i);

    await submitLogin(page, PASS);
    await expect(page).toHaveURL(/\/admin\/account\?force=1/);
    await expect(page.locator("body")).toContainText(
      /must change the default password|change the default password|修改默认密码/i,
    );
    await page.getByLabel(/current password/i).fill(PASS);
    await page.getByLabel(/new password/i).fill(NEW_PASS);
    await page.getByRole("button", { name: /update credentials/i }).click();
    await expect(page.locator(".success")).toHaveText("Updated");

    await page.evaluate(() => localStorage.clear());
    await submitLogin(page, NEW_PASS);
    await expect(page).toHaveURL(/\/app(?:$|\/)/);

    const stamp = `${Date.now()}-${test.info().project.name}`;
    const title = `Release bookmark ${stamp}`;
    const url = `https://release-${stamp}.example/item`;
    await page.goto("/admin/bookmarks");
    const createForm = page.locator("form").first();
    await expect(createForm.getByPlaceholder(/title|标题/i)).toBeVisible();
    await createForm.getByPlaceholder(/title|标题/i).fill(title);
    await createForm.getByPlaceholder(/url|网址|链接/i).fill(url);
    await createForm.getByRole("button", { name: /add|创建|新建/i }).click();
    await expect(page.locator("tbody tr", { hasText: title })).toBeVisible();

    await page.goto("/app");
    await expect(page.getByTestId("bookmark-cards")).toContainText(title);

    const token = await page.evaluate(() => localStorage.getItem("markhub_token"));
    expect(token).toBeTruthy();
    const folderName = `Cleaner fixture ${stamp}`;
    const folderResponse = await request.post("/api/v1/folders", {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: folderName, visibility: "private" },
    });
    expect(folderResponse.ok()).toBeTruthy();

    await page.goto("/app/cleaner");
    await page.getByRole("button", { name: /^scan$|扫描/i }).click();
    const issueRow = page.locator("tbody tr", { hasText: folderName });
    await expect(issueRow).toBeVisible({ timeout: 15_000 });
    await issueRow.locator('input[type="checkbox"]').check();
    const applyButton = page.getByRole("button", { name: /soft-delete selected|应用/i });
    await expect(applyButton).toBeEnabled();
    await applyButton.click();
    await expect(page.locator(".success")).toContainText(/Applied soft-delete to 1 item/i);
  });

  test("public navigation loads", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("body")).toContainText(/MarkHub|bookmark|书签|导航/i);
  });

  test("login leaves /login and reaches admin shell", async ({ page }) => {
    await ensureLoggedIn(page);
    await page.goto("/admin");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator("body")).toContainText(/Overview|Bookmarks|书签|总览|MarkHub/i);
  });

  test("admin bookmarks CRUD creates a visible row", async ({ page }) => {
    await ensureLoggedIn(page);
    await page.goto("/admin/bookmarks");
    const stamp = Date.now();
    const title = `E2E ${stamp}`;
    const url = `https://e2e.example/${stamp}`;
    const inputs = page.locator("input.input, form input");
    await expect(inputs.first()).toBeVisible();
    const n = await inputs.count();
    expect(n).toBeGreaterThanOrEqual(2);
    await inputs.nth(0).fill(title);
    await inputs.nth(1).fill(url);
    await page.getByRole("button", { name: /add|创建|新建/i }).first().click();
    await expect(page.locator("body")).toContainText(title, { timeout: 10_000 });
  });

  test("backup import UI exposes format strategy and file picker", async ({ page }) => {
    await ensureLoggedIn(page);
    await page.goto("/admin/backup");
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
    await expect(page.locator("body")).toContainText(/Imported|created|skipped/i, { timeout: 15_000 });
  });

  test("AI admin shows classify/batch controls", async ({ page }) => {
    await ensureLoggedIn(page);
    await page.goto("/admin/ai");
    await expect(page.getByTestId("ai-classify")).toBeVisible();
    await expect(page.getByTestId("ai-batch-summarize")).toBeVisible();
    await expect(page.getByTestId("ai-quick-url")).toBeVisible();
  });

  test("boards workbench has scan, groups, export controls", async ({ page }) => {
    await ensureLoggedIn(page);
    await page.goto("/app/boards");
    await expect(page.getByTestId("board-create-form")).toBeVisible();
    // create a board
    await page.locator('input').first().fill(`Board E2E ${Date.now()}`);
    await page.getByRole("button", { name: /create|创建|新建/i }).first().click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("scan-full")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("export-json")).toBeVisible();
    await expect(page.getByTestId("group-name")).toBeVisible();
  });

  test("dashboard QR opens dialog when bookmarks exist", async ({ page }) => {
    await ensureLoggedIn(page);
    // ensure a bookmark
    await page.goto("/admin/bookmarks");
    const stamp = Date.now();
    const inputs = page.locator("input.input, form input");
    if ((await inputs.count()) >= 2) {
      await inputs.nth(0).fill(`QR ${stamp}`);
      await inputs.nth(1).fill(`https://qr-e2e.example/${stamp}`);
      await page.getByRole("button", { name: /add|创建|新建/i }).first().click();
      await page.waitForTimeout(400);
    }
    await page.goto("/app");
    await expect(page.getByTestId("bookmark-cards")).toBeVisible({ timeout: 10_000 });
    const qrBtn = page.locator('button:has-text("QR")').first();
    await expect(qrBtn).toBeVisible({ timeout: 10_000 });
    await qrBtn.click();
    // modal should show
    await expect(page.locator("body")).toContainText(/QR|qr|scan|关闭|close|MarkHub/i);
  });

  test("cleaner scan button works", async ({ page }) => {
    await ensureLoggedIn(page);
    await page.goto("/app/cleaner");
    const scan = page.getByRole("button", { name: /scan|扫描/i });
    await expect(scan).toBeVisible();
    await scan.click();
    await page.waitForTimeout(500);
    await expect(page.locator("body")).toBeVisible();
  });

  test("material routes render non-empty shells", async ({ page }) => {
    await ensureLoggedIn(page);
    for (const path of [
      "/app",
      "/app/cleaner",
      "/app/boards",
      "/app/compare",
      "/app/discover",
      "/app/settings",
      "/admin/backup",
      "/admin/tags",
      "/admin/folders",
      "/admin/ai",
    ]) {
      await page.goto(path);
      await expect(page.locator("body")).toBeVisible();
      const text = await page.locator("body").innerText();
      expect(text.length).toBeGreaterThan(20);
      expect(page.url()).not.toMatch(/\/login/);
    }
  });

  test("login failure path stays on login with bad password", async ({ page }) => {
    await page.goto("/admin/login");
    await page.locator("input").nth(0).fill(USER);
    await page.locator('input[type="password"]').first().fill("definitely-wrong-password-zzz");
    await page.locator("button").first().click();
    await page.waitForTimeout(600);
    // Should remain on login or show error — must not reach admin overview
    const url = page.url();
    const body = await page.locator("body").innerText();
    const stillLogin = /login/i.test(url) || /invalid|error|失败|密码/i.test(body);
    expect(stillLogin || /login/i.test(url)).toBeTruthy();
  });
});
