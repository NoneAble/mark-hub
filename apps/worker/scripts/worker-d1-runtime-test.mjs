import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForPortsReleased } from "./port-release.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_DIR = path.resolve(WORKER_DIR, "../..");
const BOUNDED_RUN = path.join(
  os.homedir(),
  ".pi/agent/extensions/trio-workflow/bounded-run.mjs",
);
const MIGRATIONS_DIR = path.join(WORKER_DIR, "migrations");
const TEMP_ROOT = path.join(
  os.tmpdir(),
  `markhub-worker-runtime-${process.pid}-${randomUUID()}`,
);
const ADMIN_PASSWORD = "WorkerHarnessPass-2026";
const CHANGED_PASSWORD = "WorkerHarnessChanged-2026";
const JWT_SECRET = "worker-harness-jwt-secret-2026";
const MASTER_KEY = "worker-harness-master-key-2026-long";
const activeWorkers = new Set();
const usedPorts = new Set();

function phase(name) {
  console.log(`worker-d1-runtime: ${name}`);
}

function spawnBounded(command, args, options = {}) {
  return spawn(
    process.execPath,
    [
      BOUNDED_RUN,
      "--timeout-ms",
      String(options.timeoutMs || 60_000),
      "--kill-after-ms",
      "5000",
      "--",
      command,
      ...args,
    ],
    {
      cwd: options.cwd || REPO_DIR,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function runBounded(command, args, options = {}) {
  const child = spawnBounded(command, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed code=${result.code} signal=${result.signal}\n${stdout}\n${stderr}`,
    );
  }
  return { stdout, stderr };
}

async function wrangler(args, options = {}) {
  return runBounded("pnpm", ["exec", "wrangler", ...args], {
    cwd: WORKER_DIR,
    timeoutMs: options.timeoutMs || 90_000,
    env: options.env,
  });
}

async function freePort() {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const port = randomInt(49_152, 65_536);
    if (usedPorts.has(port)) continue;
    const available = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE") resolve(false);
        else reject(error);
      });
      server.listen(port, "127.0.0.1", () =>
        server.close((error) => (error ? reject(error) : resolve(true))),
      );
    });
    if (available) {
      usedPorts.add(port);
      return port;
    }
  }
  throw new Error("could not preflight a unique high loopback port");
}

async function writeConfig(name, migrationsDir = MIGRATIONS_DIR, failPhase = "") {
  const configPath = path.join(TEMP_ROOT, `${name}.toml`);
  const vars = [
    `[vars]`,
    `DEFAULT_ADMIN_USERNAME = "admin"`,
    `DEFAULT_ADMIN_PASSWORD = ${JSON.stringify(ADMIN_PASSWORD)}`,
    `JWT_SECRET = ${JSON.stringify(JWT_SECRET)}`,
    `MARKHUB_MASTER_KEY = ${JSON.stringify(MASTER_KEY)}`,
  ];
  if (failPhase) vars.push(`RESTORE_TEST_FAIL_PHASE = ${JSON.stringify(failPhase)}`);
  const content = [
    `name = "markhub-runtime-${name}"`,
    `main = ${JSON.stringify(path.join(WORKER_DIR, "src/index.ts"))}`,
    `compatibility_date = "2024-12-01"`,
    `compatibility_flags = ["nodejs_compat"]`,
    ``,
    `[[d1_databases]]`,
    `binding = "DB"`,
    `database_name = "markhub"`,
    `database_id = "00000000-0000-0000-0000-000000000000"`,
    `migrations_dir = ${JSON.stringify(migrationsDir)}`,
    ``,
    ...vars,
    ``,
  ].join("\n");
  await fs.writeFile(configPath, content, "utf8");
  return configPath;
}

async function migrate(stateDir, configPath) {
  await wrangler([
    "d1",
    "migrations",
    "apply",
    "markhub",
    "--config",
    configPath,
    "--local",
    "--persist-to",
    stateDir,
  ]);
}

async function d1Execute(stateDir, configPath, sqlOrFile, isFile = false) {
  const option = isFile ? "--file" : "--command";
  return wrangler([
    "d1",
    "execute",
    "markhub",
    "--config",
    configPath,
    "--local",
    "--persist-to",
    stateDir,
    option,
    sqlOrFile,
    "--json",
  ]);
}

function d1Rows(stdout) {
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed) && parsed.length > 0, "Wrangler D1 JSON result missing");
  return parsed[0].results || [];
}

async function findSqlite(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const item = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findSqlite(item).catch(() => null);
      if (nested) return nested;
    } else if (entry.name.endsWith(".sqlite")) {
      return item;
    }
  }
  return null;
}

async function databaseDump(stateDir) {
  const database = await findSqlite(stateDir);
  assert.ok(database, `D1 sqlite file not found under ${stateDir}`);
  const result = await runBounded("/usr/bin/sqlite3", [database, ".dump"], {
    timeoutMs: 30_000,
  });
  return result.stdout;
}

async function startWorker(stateDir, configName, failPhase = "") {
  const port = await freePort();
  const inspectorPort = await freePort();
  const configPath = await writeConfig(configName, MIGRATIONS_DIR, failPhase);
  const child = spawnBounded(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      configPath,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      stateDir,
      "--test-scheduled",
      "--log-level",
      "warn",
      "--show-interactive-dev-session=false",
    ],
    { cwd: WORKER_DIR, timeoutMs: 120_000 },
  );
  const worker = { child, port, inspectorPort, logs: "", stopped: false };
  activeWorkers.add(worker);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    worker.logs += chunk;
  });
  child.stderr.on("data", (chunk) => {
    worker.logs += chunk;
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      const body = await response.json();
      if (response.ok && body.service === "markhub-worker") {
        return worker;
      }
    } catch {
      // Readiness is bounded by the outer deadline and process liveness check.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stopWorker(worker);
  throw new Error(`Worker readiness failed on owned port ${port}\n${worker.logs}`);
}

async function stopWorker(worker) {
  if (!worker || worker.stopped) return;
  if (!worker.stopping) {
    worker.stopping = (async () => {
      const exit = new Promise((resolve) => worker.child.once("exit", resolve));
      if (worker.child.exitCode === null) {
        assert.ok(worker.child.pid, "owned bounded-run PID missing");
        process.kill(worker.child.pid, "SIGTERM");
        await Promise.race([
          exit,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`owned PID ${worker.child.pid} did not exit`)),
              12_000,
            ),
          ),
        ]);
      }
      await waitForPortsReleased([worker.port, worker.inspectorPort]);
      worker.stopped = true;
      activeWorkers.delete(worker);
    })();
  }
  try {
    await worker.stopping;
  } catch (error) {
    worker.stopping = null;
    throw error;
  }
}

async function request(
  worker,
  method,
  route,
  { token, body, rawBody, headers, timeoutMs = 10_000 } = {},
) {
  const requestHeaders = { ...(headers || {}) };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  let requestBody = rawBody;
  if (body !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }
  const response = await fetch(`http://127.0.0.1:${worker.port}${route}`, {
    method,
    headers: requestHeaders,
    body: requestBody,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Export endpoints intentionally return CSV/HTML.
  }
  return { status: response.status, text, json, headers: response.headers };
}

async function login(worker) {
  for (const password of [CHANGED_PASSWORD, ADMIN_PASSWORD]) {
    let response = await request(worker, "POST", "/api/v1/auth/login", {
      body: { username: "admin", password },
    });
    if (response.status !== 200) continue;
    let token = response.json.access_token;
    if (response.json.must_change_password) {
      const changed = await request(worker, "PUT", "/api/v1/auth/credentials", {
        token,
        body: { current_password: password, new_password: CHANGED_PASSWORD },
      });
      assert.equal(changed.status, 200, changed.text);
      response = await request(worker, "POST", "/api/v1/auth/login", {
        body: { username: "admin", password: CHANGED_PASSWORD },
      });
      assert.equal(response.status, 200, response.text);
      token = response.json.access_token;
    }
    return token;
  }
  assert.fail("unable to authenticate Worker harness admin");
}

async function createFixture(worker, token) {
  const post = async (route, body) => {
    const response = await request(worker, "POST", route, { token, body });
    assert.equal(response.status, 200, `${route}: ${response.text}`);
    return response.json;
  };
  const duplicateOne = await post("/api/v1/folders", {
    name: "Duplicate",
    visibility: "private",
  });
  const duplicateTwo = await post("/api/v1/folders", {
    name: "Duplicate",
    visibility: "public",
  });
  const slash = await post("/api/v1/folders", {
    name: "A/B",
    visibility: "unlisted",
  });
  const child = await post("/api/v1/folders", {
    name: "C",
    parent_id: slash.id,
    visibility: "public",
  });
  const empty = await post("/api/v1/folders", {
    name: "Empty/Leaf",
    visibility: "private",
  });
  let response = await request(worker, "POST", "/api/v1/folders/reorder", {
    token,
    body: {
      parent_id: null,
      ordered_ids: [duplicateOne.id, duplicateTwo.id, slash.id, empty.id],
    },
  });
  assert.equal(response.status, 200, response.text);

  await post("/api/v1/tags", { name: "red", color: "#ff0000" });
  await post("/api/v1/tags", { name: "blue", color: "#0000ff" });
  await post("/api/v1/tags", { name: "unassociated", color: "#00ff00" });
  await post("/api/v1/bookmarks", {
    title: "Duplicate One Bookmark",
    url: "https://fixture.example/duplicate-one",
    folder_id: duplicateOne.id,
    tags: ["red", "blue"],
    visibility: "unlisted",
    is_favorite: true,
    sort_order: 7,
  });
  await post("/api/v1/bookmarks", {
    title: "Duplicate Two Bookmark",
    url: "https://fixture.example/duplicate-two",
    folder_id: duplicateTwo.id,
    tags: ["blue"],
    visibility: "public",
    is_archived: true,
    sort_order: 5,
  });
  await post("/api/v1/bookmarks", {
    title: "Slash Child Bookmark",
    url: "https://fixture.example/slash-child",
    description: "description preserved through every format",
    folder_id: child.id,
    tags: ["red"],
    visibility: "private",
    sort_order: 3,
  });
}

async function runLiveContract(worker) {
  await runBounded(process.execPath, [path.join(SCRIPT_DIR, "contract-test.mjs")], {
    cwd: WORKER_DIR,
    timeoutMs: 120_000,
    env: {
      MARKHUB_WORKER_BASE: `http://127.0.0.1:${worker.port}`,
      MARKHUB_ADMIN_USERNAME: "admin",
      MARKHUB_ADMIN_PASSWORD: ADMIN_PASSWORD,
      MARKHUB_NEW_PASSWORD: CHANGED_PASSWORD,
    },
  });
}

async function exportBackup(worker, token, format) {
  const response = await request(worker, "GET", `/api/v1/backup/export?format=${format}`, {
    token,
  });
  assert.equal(response.status, 200, response.text);
  return format === "json" ? JSON.stringify(response.json) : response.text;
}

function assertFixture(payload, label) {
  const folders = payload.folders.filter((folder) => !folder.is_system);
  const duplicates = folders.filter((folder) => folder.name === "Duplicate");
  assert.equal(duplicates.length, 2, `${label}: same-parent duplicate folders`);
  assert.ok(duplicates.every((folder) => folder.parent_id === null), `${label}: duplicate parents`);
  assert.deepEqual(
    duplicates.map((folder) => folder.sort_order).sort((a, b) => a - b),
    [0, 1],
    `${label}: duplicate ordering`,
  );
  assert.deepEqual(
    duplicates.map((folder) => folder.visibility).sort(),
    ["private", "public"],
    `${label}: duplicate visibility`,
  );
  const slash = folders.find((folder) => folder.name === "A/B");
  const child = folders.find((folder) => folder.name === "C");
  const empty = folders.find((folder) => folder.name === "Empty/Leaf");
  assert.ok(slash && child && empty, `${label}: slash/child/empty folders`);
  assert.equal(child.parent_id, slash.id, `${label}: slash folder identity`);
  assert.equal(slash.sort_order, 2, `${label}: nonzero slash order`);
  assert.equal(empty.sort_order, 3, `${label}: nonzero empty order`);
  assert.equal(slash.visibility, "unlisted", `${label}: slash visibility`);
  assert.equal(child.visibility, "public", `${label}: child visibility`);

  const tags = Object.fromEntries(payload.tags.map((tag) => [tag.name, tag.color]));
  assert.equal(tags.red, "#ff0000", `${label}: red tag color`);
  assert.equal(tags.blue, "#0000ff", `${label}: blue tag color`);
  assert.equal(tags.unassociated, "#00ff00", `${label}: unassociated tag`);
  const byUrl = Object.fromEntries(payload.bookmarks.map((bookmark) => [bookmark.url, bookmark]));
  assert.deepEqual(
    [...byUrl["https://fixture.example/duplicate-one"].tags].sort(),
    ["blue", "red"],
    `${label}: tag associations`,
  );
  assert.deepEqual(byUrl["https://fixture.example/duplicate-two"].tags, ["blue"]);
  assert.equal(
    byUrl["https://fixture.example/slash-child"].description,
    "description preserved through every format",
    `${label}: description fidelity`,
  );
  assert.equal(byUrl["https://fixture.example/duplicate-one"].is_favorite, true);
  assert.equal(byUrl["https://fixture.example/duplicate-two"].is_archived, true);
}

async function importAndAssert(stateDir, format, content) {
  const worker = await startWorker(stateDir, `destination-${format}`);
  try {
    const token = await login(worker);
    const imported = await request(worker, "POST", "/api/v1/backup/import", {
      token,
      body: {
        content,
        format,
        strategy: "replace_all",
        confirm_replace: true,
      },
    });
    assert.equal(imported.status, 200, `${format}: ${imported.text}`);
    const exported = await request(worker, "GET", "/api/v1/backup/export?format=json", {
      token,
    });
    assert.equal(exported.status, 200, exported.text);
    assertFixture(exported.json, `${format} A-to-B`);
  } finally {
    await stopWorker(worker);
  }
}

async function testMergeDuplicateSelection(stateDir, configPath) {
  const targetUrl = "https://kd31.example/prefer-target";
  const fallbackUrl = "https://kd31.example/fallback-oldest";
  let fixture;
  const seedWorker = await startWorker(stateDir, "kd31-seed");
  try {
    const token = await login(seedWorker);
    const create = async (route, body) => {
      const response = await request(seedWorker, "POST", route, { token, body });
      assert.equal(response.status, 200, `${route}: ${response.text}`);
      return response.json;
    };
    const targetFolder = await create("/api/v1/folders", { name: "KD31 Target" });
    const outsideOldFolder = await create("/api/v1/folders", { name: "KD31 Outside Old" });
    const outsideNewFolder = await create("/api/v1/folders", { name: "KD31 Outside New" });
    const targetOutside = await create("/api/v1/bookmarks", {
      title: "Target URL oldest outside",
      url: targetUrl,
      folder_id: outsideOldFolder.id,
    });
    const targetMatch = await create("/api/v1/bookmarks", {
      title: "Target URL duplicate in target",
      url: targetUrl,
      folder_id: targetFolder.id,
    });
    const fallbackOld = await create("/api/v1/bookmarks", {
      title: "Fallback oldest",
      url: fallbackUrl,
      folder_id: outsideOldFolder.id,
    });
    const fallbackNew = await create("/api/v1/bookmarks", {
      title: "Fallback newer",
      url: fallbackUrl,
      folder_id: outsideNewFolder.id,
    });
    fixture = {
      targetFolder,
      outsideOldFolder,
      outsideNewFolder,
      targetOutside,
      targetMatch,
      fallbackOld,
      fallbackNew,
    };
  } finally {
    await stopWorker(seedWorker);
  }

  const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const createdAt = new Map([
    [fixture.targetOutside.id, "2020-01-01T00:00:00.000Z"],
    [fixture.targetMatch.id, "2021-01-01T00:00:00.000Z"],
    [fixture.fallbackOld.id, "2020-01-01T00:00:00.000Z"],
    [fixture.fallbackNew.id, "2021-01-01T00:00:00.000Z"],
  ]);
  const timestampCases = [...createdAt]
    .map(([id, timestamp]) => `WHEN ${sqlString(id)} THEN ${sqlString(timestamp)}`)
    .join(" ");
  await d1Execute(
    stateDir,
    configPath,
    `UPDATE bookmarks SET created_at = CASE id ${timestampCases} ELSE created_at END
     WHERE id IN (${[...createdAt.keys()].map(sqlString).join(", ")})`,
  );

  const worker = await startWorker(stateDir, "kd31-assert");
  try {
    const token = await login(worker);
    const imported = await request(worker, "POST", "/api/v1/backup/import", {
      token,
      body: {
        format: "json",
        strategy: "merge",
        content: JSON.stringify({
          format: "markhub-json",
          version: 1,
          folders: [],
          tags: [],
          bookmarks: [
            {
              title: "Target URL merged in place",
              url: targetUrl,
              folder_path: [fixture.targetFolder.name],
            },
            {
              title: "Fallback oldest merged",
              url: fallbackUrl,
              folder_path: [fixture.targetFolder.name],
            },
          ],
        }),
      },
    });
    assert.equal(imported.status, 200, imported.text);
    assert.equal(imported.json?.merged, 2, imported.text);
    assert.equal(imported.json?.created, 0, imported.text);

    const getBookmark = async (id) => {
      const response = await request(worker, "GET", `/api/v1/bookmarks/${id}`, { token });
      assert.equal(response.status, 200, response.text);
      return response.json;
    };
    const [targetOutside, targetMatch, fallbackOld, fallbackNew] = await Promise.all([
      getBookmark(fixture.targetOutside.id),
      getBookmark(fixture.targetMatch.id),
      getBookmark(fixture.fallbackOld.id),
      getBookmark(fixture.fallbackNew.id),
    ]);

    assert.equal(targetOutside.title, "Target URL oldest outside");
    assert.equal(targetOutside.folder_id, fixture.outsideOldFolder.id);
    assert.equal(targetMatch.title, "Target URL merged in place");
    assert.equal(targetMatch.folder_id, fixture.targetFolder.id);
    assert.equal(fallbackOld.title, "Fallback oldest merged");
    assert.equal(fallbackOld.folder_id, fixture.targetFolder.id);
    assert.equal(fallbackNew.title, "Fallback newer");
    assert.equal(fallbackNew.folder_id, fixture.outsideNewFolder.id);
  } finally {
    await stopWorker(worker);
  }
}

async function testAtomicFailures(stateDir, restoreContent) {
  const before = await databaseDump(stateDir);
  for (const failPhase of ["insert", "swap"]) {
    const worker = await startWorker(stateDir, `restore-fail-${failPhase}`, failPhase);
    try {
      const token = await login(worker);
      const response = await request(worker, "POST", "/api/v1/backup/import", {
        token,
        body: {
          content: restoreContent,
          format: "json",
          strategy: "replace_all",
          confirm_replace: true,
        },
      });
      assert.equal(response.status, 500, `${failPhase}: ${response.text}`);
      assert.equal(response.json?.error?.code, "restore_failed");
    } finally {
      await stopWorker(worker);
    }
    const after = await databaseDump(stateDir);
    assert.equal(after, before, `${failPhase}: complete D1 pre-state changed`);
  }
}

async function testMcpOriginParity(stateDir) {
  const worker = await startWorker(stateDir, "mcp-origins");
  try {
    const token = await login(worker);
    const generated = await request(worker, "POST", "/api/v1/settings/mcp/token", { token });
    assert.equal(generated.status, 200, generated.text);
    const staticToken = generated.json.token;
    const configured = await request(worker, "PUT", "/api/v1/settings/mcp", {
      token,
      body: { enabled: true, allowed_origins: "https://allowed.example" },
    });
    assert.equal(configured.status, 200, configured.text);

    const oauth = await request(worker, "POST", "/api/v1/oauth/token", {
      body: {
        grant_type: "client_credentials",
        client_id: "markhub-mcp",
        client_secret: staticToken,
      },
    });
    assert.equal(oauth.status, 200, oauth.text);
    const credentials = [
      ["static", staticToken],
      ["oauth", oauth.json.access_token],
    ];
    for (const [kind, bearer] of credentials) {
      const missing = await request(worker, "GET", "/api/v1/mcp", {
        token: bearer,
      });
      assert.equal(missing.status, 200, `${kind} missing Origin: ${missing.text}`);
      const forbidden = await request(worker, "GET", "/api/v1/mcp", {
        token: bearer,
        headers: { Origin: "https://forbidden.example" },
      });
      assert.equal(forbidden.status, 403, `${kind}: ${forbidden.text}`);
      assert.equal(forbidden.json?.error?.code, "forbidden_origin", kind);
      const allowed = await request(worker, "GET", "/api/v1/mcp", {
        token: bearer,
        headers: { Origin: "https://allowed.example" },
      });
      assert.equal(allowed.status, 200, `${kind}: ${allowed.text}`);

      const before = await request(worker, "GET", "/api/v1/bookmarks", { token });
      assert.equal(before.status, 200, before.text);
      const beforeCount = before.json.items.length;
      const forbiddenWrite = await request(worker, "POST", "/api/v1/mcp", {
        token: bearer,
        headers: { Origin: "https://forbidden.example" },
        body: {
          jsonrpc: "2.0",
          id: `${kind}-forbidden-write`,
          method: "tools/call",
          params: {
            name: "add_markhub_bookmark",
            arguments: {
              title: `${kind} forbidden Origin write`,
              url: `https://${kind}-forbidden-origin.example/item`,
            },
          },
        },
      });
      assert.equal(forbiddenWrite.status, 403, `${kind}: ${forbiddenWrite.text}`);
      assert.equal(forbiddenWrite.json?.error?.code, "forbidden_origin", kind);
      const after = await request(worker, "GET", "/api/v1/bookmarks", { token });
      assert.equal(after.status, 200, after.text);
      assert.equal(
        after.json.items.length,
        beforeCount,
        `${kind}: forbidden Origin MCP write mutated bookmarks`,
      );
    }
  } finally {
    await stopWorker(worker);
  }
}

async function testExpiry(worker, token) {
  const bookmark = await request(worker, "POST", "/api/v1/bookmarks", {
    token,
    body: {
      title: "Expiry target",
      url: "https://fixture.example/expiry",
    },
  });
  assert.equal(bookmark.status, 200, bookmark.text);
  const create = (expiresAt) =>
    request(worker, "POST", "/api/v1/shares", {
      token,
      body: {
        target_type: "bookmark",
        target_id: bookmark.json.id,
        expires_at: expiresAt,
      },
    });
  const past = await create("2025-01-02T03:04:05+08:00");
  assert.equal(past.status, 200, past.text);
  assert.equal(past.json.expires_at, "2025-01-01T19:04:05.000Z");
  const expired = await request(worker, "GET", `/api/v1/shares/${past.json.token}`);
  assert.equal(expired.status, 410, expired.text);

  const future = await create("2099-01-02T03:04:05-05:30");
  assert.equal(future.status, 200, future.text);
  assert.equal(future.json.expires_at, "2099-01-02T08:34:05.000Z");
  const resolved = await request(worker, "GET", `/api/v1/shares/${future.json.token}`);
  assert.equal(resolved.status, 200, resolved.text);
  for (const invalid of [
    "2026-02-30T00:00:00Z",
    "2026-01-01T00:00:00",
    " 2026-01-01T00:00:00Z",
    123,
  ]) {
    const response = await create(invalid);
    assert.equal(response.status, 400, `invalid expiry ${JSON.stringify(invalid)}: ${response.text}`);
  }
}

async function testShareUnlockThrottle(worker, token) {
  const bookmark = await request(worker, "POST", "/api/v1/bookmarks", {
    token,
    body: {
      title: "Protected share target",
      url: "https://fixture.example/protected-share",
    },
  });
  assert.equal(bookmark.status, 200, bookmark.text);
  const share = await request(worker, "POST", "/api/v1/shares", {
    token,
    body: {
      target_type: "bookmark",
      target_id: bookmark.json.id,
      password: "secret-pass",
    },
  });
  assert.equal(share.status, 200, share.text);
  const route = `/api/v1/shares/${share.json.token}/unlock`;

  const valid = await request(worker, "POST", route, {
    headers: {
      "CF-Connecting-IP": "203.0.113.1",
      "X-Forwarded-For": "198.51.100.1",
    },
    body: { password: "secret-pass" },
  });
  assert.equal(valid.status, 200, valid.text);

  const statuses = [];
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const failed = await request(worker, "POST", route, {
      headers: {
        "CF-Connecting-IP": `203.0.113.${attempt + 2}`,
        "X-Forwarded-For": `198.51.100.${attempt + 2}`,
      },
      body: { password: "wrong" },
    });
    statuses.push(failed.status);
    if (failed.status === 429) break;
  }
  assert.deepEqual(statuses, [...Array(10).fill(401), 429]);
}

async function testMalformedImports(stateDir) {
  const worker = await startWorker(stateDir, "malformed-imports");
  try {
    const token = await login(worker);
    const valid = { title: "valid", url: "https://valid.example" };
    const cases = [
      ["missing content", {}],
      ["null content", { content: null, format: "json", strategy: "replace_all", confirm_replace: true }],
      ["array content", { content: [], format: "json", strategy: "replace_all", confirm_replace: true }],
      ["unsupported format", { content: "{}", format: "yaml", strategy: "replace_all", confirm_replace: true }],
      ["unsupported strategy", { content: "[]", format: "json", strategy: "destroy", confirm_replace: true }],
      ["unknown native version", {
        content: JSON.stringify({ format: "markhub-json", version: 99, bookmarks: [], folders: [], tags: [] }),
        format: "json",
        strategy: "replace_all",
        confirm_replace: true,
      }],
      ["missing bookmarks", {
        content: JSON.stringify({ format: "markhub-json", version: 1, folders: [], tags: [] }),
        format: "json",
        strategy: "replace_all",
        confirm_replace: true,
      }],
      ["null bookmarks", {
        content: JSON.stringify({ format: "markhub-json", version: 1, bookmarks: null, folders: [], tags: [] }),
        format: "json",
        strategy: "replace_all",
        confirm_replace: true,
      }],
      ["wrong-type bookmarks", {
        content: JSON.stringify({ format: "markhub-json", version: 1, bookmarks: {}, folders: [], tags: [] }),
        format: "json",
        strategy: "replace_all",
        confirm_replace: true,
      }],
      ["missing folders", {
        content: JSON.stringify({ format: "markhub-json", version: 1, bookmarks: [], tags: [] }),
        format: "json",
        strategy: "replace_all",
        confirm_replace: true,
      }],
      ["null folders", {
        content: JSON.stringify({ format: "markhub-json", version: 1, bookmarks: [], folders: null, tags: [] }),
        format: "json",
        strategy: "replace_all",
        confirm_replace: true,
      }],
      ["wrong-type folders", {
        content: JSON.stringify({ format: "markhub-json", version: 1, bookmarks: [], folders: {}, tags: [] }),
        format: "json",
        strategy: "replace_all",
        confirm_replace: true,
      }],
      ["missing tags", {
        content: JSON.stringify({ format: "markhub-json", version: 1, bookmarks: [], folders: [] }),
        format: "json",
        strategy: "replace_all",
        confirm_replace: true,
      }],
      ["null tags", {
        content: JSON.stringify({ format: "markhub-json", version: 1, bookmarks: [], folders: [], tags: null }),
        format: "json",
        strategy: "replace_all",
        confirm_replace: true,
      }],
      ["wrong-type tags", {
        content: JSON.stringify({ format: "markhub-json", version: 1, bookmarks: [], folders: [], tags: {} }),
        format: "json",
        strategy: "replace_all",
        confirm_replace: true,
      }],
      ["partially invalid json", {
        content: JSON.stringify({
          format: "markhub-json",
          version: 1,
          bookmarks: [valid, { title: "invalid" }],
          folders: [],
          tags: [],
        }),
        format: "json",
        strategy: "replace_all",
        confirm_replace: true,
      }],
      ["partially invalid folders", {
        content: JSON.stringify({
          format: "markhub-json",
          version: 1,
          bookmarks: [],
          folders: [{ id: "valid-folder", name: "Valid" }, { name: "Missing id" }],
          tags: [],
        }),
        format: "json",
        strategy: "replace_all",
        confirm_replace: true,
      }],
      ["partially invalid tags", {
        content: JSON.stringify({
          format: "markhub-json",
          version: 1,
          bookmarks: [],
          folders: [],
          tags: [{ id: "valid-tag", name: "valid" }, { id: "invalid-tag" }],
        }),
        format: "json",
        strategy: "replace_all",
        confirm_replace: true,
      }],
      ["partially invalid csv", {
        content: "title,url\nValid,https://valid.example\nInvalid,",
        format: "csv",
        strategy: "replace_all",
        confirm_replace: true,
      }],
      ["partially invalid html", {
        content:
          '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n<DT><A HREF="https://valid.example">Valid</A>\n<DT><A HREF="">Invalid</A>\n</DL><p>',
        format: "html",
        strategy: "replace_all",
        confirm_replace: true,
      }],
    ];
    for (const [label, body] of cases) {
      const before = await databaseDump(stateDir);
      const response = await request(worker, "POST", "/api/v1/backup/import", {
        token,
        body,
      });
      assert.ok(response.status >= 400 && response.status < 500, `${label}: ${response.text}`);
      const after = await databaseDump(stateDir);
      assert.equal(after, before, `${label}: rejected destructive import changed D1 state`);
    }

    const empty = await request(worker, "POST", "/api/v1/backup/import", {
      token,
      body: {
        content: JSON.stringify({
          format: "markhub-json",
          version: 1,
          bookmarks: [],
          folders: [],
          tags: [],
        }),
        format: "json",
        strategy: "replace_all",
        confirm_replace: true,
      },
    });
    assert.equal(empty.status, 200, empty.text);
    assert.equal(empty.json?.atomic, true, empty.text);
    const exported = await request(worker, "GET", "/api/v1/backup/export?format=json", { token });
    assert.equal(exported.status, 200, exported.text);
    assert.equal(exported.json.bookmarks.length, 0, "valid empty restore retained bookmarks");
    assert.equal(
      exported.json.folders.filter((folder) => !folder.is_system).length,
      0,
      "valid empty restore retained non-system folders",
    );
    assert.equal(exported.json.tags.length, 0, "valid empty restore retained tags");
  } finally {
    await stopWorker(worker);
  }
}

function largeRestoreContents(count = 460) {
  const bookmarks = Array.from({ length: count }, (_, index) => ({
    title: `Large ${index}`,
    url: `https://large.example/${index}`,
    folder_id: "large-folder",
    tags: ["large-one", "large-two"],
    sort_order: index,
  }));
  const jsonContent = JSON.stringify({
    format: "markhub-json",
    version: 1,
    folders: [
      {
        id: "large-folder",
        parent_id: null,
        name: "Large",
        sort_order: 0,
        visibility: "private",
        is_system: false,
      },
    ],
    tags: [
      { id: "large-one", name: "large-one", color: "#112233" },
      { id: "large-two", name: "large-two", color: "#445566" },
    ],
    bookmarks,
  });
  const csvContent = [
    "title,url,folder,tags,sort_order",
    ...bookmarks.map(
      (bookmark) =>
        `${bookmark.title},${bookmark.url},Large,"large-one,large-two",${bookmark.sort_order}`,
    ),
  ].join("\n");
  const htmlContent = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<DL><p>",
    "<DT><H3>Large</H3>",
    "<DL><p>",
    ...bookmarks.map(
      (bookmark) =>
        `<DT><A HREF="${bookmark.url}" TAGS="large-one,large-two">${bookmark.title}</A>`,
    ),
    "</DL><p>",
    "</DL><p>",
  ].join("\n");
  return { count, json: jsonContent, csv: csvContent, html: htmlContent };
}

async function testLargeAtomicRestores(stateDir, configPath) {
  const worker = await startWorker(stateDir, "large-restores");
  try {
    const token = await login(worker);
    const contents = largeRestoreContents();
    for (const format of ["json", "csv", "html"]) {
      const imported = await request(worker, "POST", "/api/v1/backup/import", {
        token,
        timeoutMs: 30_000,
        body: {
          content: contents[format],
          format,
          strategy: "replace_all",
          confirm_replace: true,
        },
      });
      assert.equal(imported.status, 200, `${format}: ${imported.text}`);
      assert.equal(imported.json?.atomic, true, `${format}: restore was not atomic`);
      assert.equal(imported.json?.created, contents.count, `${format}: created count`);
      const exported = await request(worker, "GET", "/api/v1/backup/export?format=json", {
        token,
        timeoutMs: 30_000,
      });
      assert.equal(exported.status, 200, `${format}: ${exported.text}`);
      assert.equal(exported.json.bookmarks.length, contents.count, `${format}: restored count`);
      const urls = new Set(exported.json.bookmarks.map((bookmark) => bookmark.url));
      assert.ok(urls.has("https://large.example/0"), `${format}: first bookmark missing`);
      assert.ok(
        urls.has(`https://large.example/${contents.count - 1}`),
        `${format}: last bookmark missing`,
      );
    }
  } finally {
    await stopWorker(worker);
  }
  const staging = d1Rows(
    (await d1Execute(stateDir, configPath, "SELECT COUNT(*) AS count FROM restore_staging")).stdout,
  )[0];
  assert.deepEqual(staging, { count: 0 }, "large restores left staging rows behind");
}

async function seedAndTestCronGc(stateDir, configPath) {
  const seedPath = path.join(TEMP_ROOT, "cron-gc.sql");
  await fs.writeFile(
    seedPath,
    `INSERT INTO folders (id, user_id, parent_id, name, sort_order, visibility, is_system, deleted_at, created_at, updated_at)
     VALUES ('gc-parent', (SELECT id FROM users LIMIT 1), NULL, 'GC Parent', 0, 'private', 0, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
     INSERT INTO folders (id, user_id, parent_id, name, sort_order, visibility, is_system, deleted_at, created_at, updated_at)
     VALUES ('gc-child', (SELECT id FROM users LIMIT 1), 'gc-parent', 'GC Child', 0, 'private', 0, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');`,
    "utf8",
  );
  await d1Execute(stateDir, configPath, seedPath, true);
  const worker = await startWorker(stateDir, "cron-gc");
  try {
    const response = await request(worker, "GET", "/__scheduled");
    assert.equal(response.status, 200, response.text);
  } finally {
    await stopWorker(worker);
  }
  const remaining = d1Rows(
    (await d1Execute(
      stateDir,
      configPath,
      "SELECT id FROM folders WHERE id IN ('gc-parent', 'gc-child') ORDER BY id",
    )).stdout,
  );
  assert.deepEqual(remaining, [], "cron did not delete stale nested folders child-first");
  const fk = d1Rows(
    (await d1Execute(stateDir, configPath, "PRAGMA foreign_key_check")).stdout,
  );
  assert.deepEqual(fk, [], "cron GC left foreign-key violations");
}

async function testScheduledBoardIncremental(stateDir, configPath) {
  let userId;
  let folderId;
  let boardId;
  let initialCursor;
  let worker = await startWorker(stateDir, "scheduled-board-setup");
  try {
    const token = await login(worker);
    const folder = await request(worker, "POST", "/api/v1/folders", {
      token,
      body: { name: "Scheduled Board Source" },
    });
    assert.equal(folder.status, 200, folder.text);
    folderId = folder.json.id;
    const existing = await request(worker, "POST", "/api/v1/bookmarks", {
      token,
      body: {
        title: "Scheduled Existing",
        url: "https://scheduled.example/existing",
        folder_id: folderId,
      },
    });
    assert.equal(existing.status, 200, existing.text);
    userId = existing.json.user_id;
    const board = await request(worker, "POST", "/api/v1/boards", {
      token,
      body: { name: "Scheduled Board", source_folder_ids: [folderId] },
    });
    assert.equal(board.status, 200, board.text);
    boardId = board.json.id;
    const scanned = await request(worker, "POST", `/api/v1/boards/${boardId}/scan`, {
      token,
      body: { mode: "full" },
    });
    assert.equal(scanned.status, 200, scanned.text);
    assert.equal(scanned.json.mode, "full", scanned.text);
    initialCursor = Number(scanned.json.cursor);
    assert.ok(initialCursor > 0, `initial board cursor=${initialCursor}`);
  } finally {
    await stopWorker(worker);
  }

  const seedPath = path.join(TEMP_ROOT, "scheduled-board-incremental.sql");
  await fs.writeFile(
    seedPath,
    `INSERT INTO bookmarks
       (id, user_id, folder_id, title, url, url_normalized, description, visibility,
        is_favorite, is_archived, sort_order, link_status, created_at, updated_at)
     VALUES
       ('scheduled-new', '${userId}', '${folderId}', 'Scheduled New',
        'https://scheduled.example/new', 'https://scheduled.example/new', NULL, 'private',
        0, 0, 0, 'unknown', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');
     INSERT INTO op_logs (user_id, entity_type, entity_id, action, snapshot, created_at)
     VALUES ('${userId}', 'bookmark', 'scheduled-new', 'create',
             '{"id":"scheduled-new"}', '2026-07-13T00:00:00.000Z');`,
    "utf8",
  );
  await d1Execute(stateDir, configPath, seedPath, true);

  worker = await startWorker(stateDir, "scheduled-board-trigger");
  try {
    const response = await request(worker, "GET", "/__scheduled");
    assert.equal(response.status, 200, response.text);
    const token = await login(worker);
    const annotations = await request(
      worker,
      "GET",
      `/api/v1/boards/${boardId}/annotations`,
      { token },
    );
    assert.equal(annotations.status, 200, annotations.text);
    const incremental = annotations.json.items.find(
      (annotation) => annotation.bookmark_id === "scheduled-new",
    );
    assert.ok(incremental, "scheduled incremental scan did not create the annotation");
    assert.equal(incremental.present, true, JSON.stringify(incremental));
    assert.equal(incremental.source_folder_id, folderId, JSON.stringify(incremental));
    const board = await request(worker, "GET", `/api/v1/boards/${boardId}`, { token });
    assert.equal(board.status, 200, board.text);
    assert.ok(
      Number(board.json.last_incremental_cursor) > initialCursor,
      `scheduled cursor did not advance: ${board.json.last_incremental_cursor} <= ${initialCursor}`,
    );
  } finally {
    await stopWorker(worker);
  }
}

async function testPopulatedMigration() {
  const partialMigrations = path.join(TEMP_ROOT, "migrations-before-fk");
  await fs.mkdir(partialMigrations, { recursive: true });
  for (const name of ["0001_init.sql", "0002_cleaner.sql", "0003_rate_limits.sql", "0004_ai_tasks.sql"]) {
    await fs.copyFile(path.join(MIGRATIONS_DIR, name), path.join(partialMigrations, name));
  }
  const stateDir = path.join(TEMP_ROOT, "populated-upgrade");
  const beforeConfig = await writeConfig("populated-before", partialMigrations);
  await migrate(stateDir, beforeConfig);
  const seedPath = path.join(TEMP_ROOT, "populated-seed.sql");
  await fs.writeFile(
    seedPath,
    `INSERT INTO users VALUES ('pop-user','populated','hash',0,'2026-01-01','2026-01-01');
     INSERT INTO folders VALUES ('pop-root','pop-user',NULL,'Root',1,'private',0,NULL,'2026-01-01','2026-01-01');
     INSERT INTO folders VALUES ('pop-child','pop-user','pop-root','Child',2,'public',0,NULL,'2026-01-01','2026-01-01');
     INSERT INTO bookmarks VALUES ('pop-bookmark','pop-user','pop-child','Bookmark','https://pop.example','https://pop.example/',NULL,'private',1,0,3,NULL,NULL,'unknown',NULL,'2026-01-01','2026-01-01');
     INSERT INTO tags VALUES ('pop-tag','pop-user','tag','#123456','2026-01-01','2026-01-01');
     INSERT INTO bookmark_tags (bookmark_id,tag_id) VALUES ('pop-bookmark','pop-tag');
     INSERT INTO settings (user_id,key,value,is_secret) VALUES ('pop-user','key','value',0);
     INSERT INTO op_logs (user_id,entity_type,entity_id,action,snapshot,created_at) VALUES ('pop-user','bookmark','pop-bookmark','create','{}','2026-01-01');
     INSERT INTO reorder_clocks (user_id,scope,parent_id,updated_at) VALUES ('pop-user','folder','','2026-01-01');
     INSERT INTO boards VALUES ('pop-board','pop-user','Board','ai_channels','[]',1,NULL,NULL,'2026-01-01','2026-01-01');
     INSERT INTO board_groups VALUES ('pop-group','pop-board','Group',NULL,'[]',0,0);
     INSERT INTO annotations VALUES ('pop-ann','pop-board','pop-bookmark','pending','','',NULL,'pop-group','[]',NULL,NULL,'pop-child','Root/Child',1,'2026-01-01','2026-01-01',NULL,'2026-01-01','{}');
     INSERT INTO share_links VALUES ('pop-share','pop-user','pop-token','bookmark','pop-bookmark',NULL,NULL,'2026-01-01');
     INSERT INTO clean_jobs VALUES ('pop-job','pop-user','done',0,1,1,NULL,'2026-01-01','2026-01-01');
     INSERT INTO clean_issues VALUES ('pop-issue','pop-job','pop-user','duplicate','bookmark','pop-bookmark',NULL,'2026-01-01');
     INSERT INTO ai_tasks VALUES ('pop-task','pop-user','batch','done',1,'{}','{}',NULL,'2026-01-01','2026-01-01');

     INSERT INTO folders VALUES ('orphan-parent','pop-user','missing-folder','Repair parent',4,'private',0,NULL,'2026-01-01','2026-01-01');
     INSERT INTO folders VALUES ('orphan-user-folder','missing-user',NULL,'Delete folder',5,'private',0,NULL,'2026-01-01','2026-01-01');
     INSERT INTO bookmarks VALUES ('orphan-folder-bookmark','pop-user','missing-folder','Delete bookmark','https://orphan-folder.example','https://orphan-folder.example/',NULL,'private',0,0,0,NULL,NULL,'unknown',NULL,'2026-01-01','2026-01-01');
     INSERT INTO bookmarks VALUES ('orphan-user-bookmark','missing-user','pop-child','Delete bookmark','https://orphan-user.example','https://orphan-user.example/',NULL,'private',0,0,0,NULL,NULL,'unknown',NULL,'2026-01-01','2026-01-01');
     INSERT INTO tags VALUES ('orphan-user-tag','missing-user','delete-tag',NULL,'2026-01-01','2026-01-01');
     INSERT INTO bookmark_tags (bookmark_id,tag_id) VALUES ('missing-bookmark','pop-tag');
     INSERT INTO bookmark_tags (bookmark_id,tag_id) VALUES ('pop-bookmark','orphan-user-tag');
     INSERT INTO settings (user_id,key,value,is_secret) VALUES ('missing-user','delete-setting','value',0);
     INSERT INTO op_logs (user_id,entity_type,entity_id,action,snapshot,created_at) VALUES ('missing-user','bookmark','missing','create','{}','2026-01-01');
     INSERT INTO reorder_clocks (user_id,scope,parent_id,updated_at) VALUES ('missing-user','folder','','2026-01-01');
     INSERT INTO boards VALUES ('orphan-user-board','missing-user','Delete board','custom','[]',1,NULL,NULL,'2026-01-01','2026-01-01');
     INSERT INTO board_groups VALUES ('orphan-board-group','missing-board','Delete group',NULL,'[]',0,0);
     INSERT INTO annotations VALUES ('repair-annotation','pop-board','pop-bookmark','pending','','',NULL,'missing-group','[]',NULL,NULL,'missing-folder','Missing',1,'2026-01-01','2026-01-01',NULL,'2026-01-01','{}');
     INSERT INTO annotations VALUES ('orphan-annotation','missing-board','missing-bookmark','pending','','',NULL,NULL,'[]',NULL,NULL,NULL,NULL,1,'2026-01-01','2026-01-01',NULL,'2026-01-01','{}');
     INSERT INTO share_links VALUES ('orphan-user-share','missing-user','delete-token','bookmark','missing',NULL,NULL,'2026-01-01');
     INSERT INTO clean_jobs VALUES ('orphan-user-job','missing-user','done',0,1,1,NULL,'2026-01-01','2026-01-01');
     INSERT INTO clean_issues VALUES ('orphan-job-issue','missing-job','pop-user','duplicate','bookmark','missing',NULL,'2026-01-01');
     INSERT INTO clean_issues VALUES ('orphan-user-issue','pop-job','missing-user','duplicate','bookmark','missing',NULL,'2026-01-01');
     INSERT INTO ai_tasks VALUES ('orphan-user-task','missing-user','batch','done',1,'{}','{}',NULL,'2026-01-01','2026-01-01');`,
    "utf8",
  );
  await d1Execute(stateDir, beforeConfig, seedPath, true);
  const fullConfig = await writeConfig("populated-after", MIGRATIONS_DIR);
  await migrate(stateDir, fullConfig);
  const fk = d1Rows(
    (await d1Execute(stateDir, fullConfig, "PRAGMA foreign_key_check")).stdout,
  );
  assert.deepEqual(fk, [], "populated migration foreign_key_check failed");
  const counts = d1Rows(
    (
      await d1Execute(
        stateDir,
        fullConfig,
        `SELECT
           (SELECT COUNT(*) FROM folders) AS folders,
           (SELECT COUNT(*) FROM bookmarks) AS bookmarks,
           (SELECT COUNT(*) FROM bookmark_tags) AS bookmark_tags,
           (SELECT COUNT(*) FROM annotations) AS annotations,
           (SELECT COUNT(*) FROM clean_issues) AS clean_issues`,
      )
    ).stdout,
  )[0];
  assert.deepEqual(counts, {
    folders: 3,
    bookmarks: 1,
    bookmark_tags: 1,
    annotations: 2,
    clean_issues: 1,
  });
  const repaired = d1Rows(
    (
      await d1Execute(
        stateDir,
        fullConfig,
        `SELECT
           (SELECT COUNT(*) FROM folders WHERE id = 'orphan-parent' AND parent_id IS NULL) AS repaired_parent,
           (SELECT COUNT(*) FROM annotations WHERE id = 'repair-annotation' AND group_id IS NULL AND source_folder_id IS NULL) AS repaired_annotation,
           (SELECT COUNT(*) FROM folders WHERE id = 'orphan-user-folder') +
           (SELECT COUNT(*) FROM bookmarks WHERE id IN ('orphan-folder-bookmark','orphan-user-bookmark')) +
           (SELECT COUNT(*) FROM tags WHERE id = 'orphan-user-tag') +
           (SELECT COUNT(*) FROM boards WHERE id = 'orphan-user-board') +
           (SELECT COUNT(*) FROM board_groups WHERE id = 'orphan-board-group') +
           (SELECT COUNT(*) FROM annotations WHERE id = 'orphan-annotation') +
           (SELECT COUNT(*) FROM share_links WHERE id = 'orphan-user-share') +
           (SELECT COUNT(*) FROM clean_jobs WHERE id = 'orphan-user-job') +
           (SELECT COUNT(*) FROM clean_issues WHERE id IN ('orphan-job-issue','orphan-user-issue')) +
           (SELECT COUNT(*) FROM ai_tasks WHERE id = 'orphan-user-task') AS remaining_orphans`,
      )
    ).stdout,
  )[0];
  assert.deepEqual(repaired, {
    repaired_parent: 1,
    repaired_annotation: 1,
    remaining_orphans: 0,
  });
}

async function testForeignKeyGuard(freshState, freshConfig) {
  const guardState = await cloneState(freshState, "foreign-key-guard");
  const database = await findSqlite(guardState);
  assert.ok(database, "foreign-key guard D1 file missing");
  await runBounded(
    "/usr/bin/sqlite3",
    [
      database,
      `PRAGMA foreign_keys=OFF;
       INSERT INTO folders
         (id, user_id, parent_id, name, sort_order, visibility, is_system, deleted_at, created_at, updated_at)
       VALUES
         ('guard-orphan', 'missing-user', NULL, 'Guard Orphan', 0, 'private', 0, NULL, '2026-01-01', '2026-01-01');`,
    ],
    { timeoutMs: 30_000 },
  );
  const migrationSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, "0005_foreign_keys.sql"),
    "utf8",
  );
  const guardStart = migrationSql.indexOf("-- A bare foreign_key_check");
  assert.ok(guardStart >= 0, "production foreign-key guard marker missing");
  const guardPath = path.join(TEMP_ROOT, "foreign-key-guard.sql");
  await fs.writeFile(guardPath, migrationSql.slice(guardStart), "utf8");
  let failed = false;
  try {
    await d1Execute(guardState, freshConfig, guardPath, true);
  } catch (error) {
    failed = true;
    assert.match(String(error), /CHECK constraint failed/i);
  }
  assert.equal(failed, true, "foreign-key guard did not abort on a violation row");
}

async function cloneState(source, name) {
  const destination = path.join(TEMP_ROOT, name);
  await fs.cp(source, destination, { recursive: true });
  return destination;
}

async function main() {
  const focus = process.argv.find((argument) => argument.startsWith("--focus="));
  if (focus && focus !== "--focus=kd31") {
    throw new Error(`unknown Worker runtime test focus: ${focus}`);
  }
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const freshState = path.join(TEMP_ROOT, "fresh-migrated");
  const freshConfig = await writeConfig("fresh", MIGRATIONS_DIR);

  phase("fresh D1 migrations and foreign_key_check");
  await migrate(freshState, freshConfig);
  assert.deepEqual(
    d1Rows((await d1Execute(freshState, freshConfig, "PRAGMA foreign_key_check")).stdout),
    [],
  );

  if (focus === "--focus=kd31") {
    phase("KD-31 merge target-folder priority and oldest-live fallback");
    const kd31State = await cloneState(freshState, "kd31-merge");
    await testMergeDuplicateSelection(kd31State, freshConfig);
    console.log("worker-d1-runtime: PASS (KD-31 focused)");
    return;
  }

  phase("nonzero foreign_key_check migration guard");
  await testForeignKeyGuard(freshState, freshConfig);

  phase("populated dependency-safe D1 upgrade");
  await testPopulatedMigration();

  phase("live Worker parity/security contract");
  const contractState = await cloneState(freshState, "contract");
  const contractWorker = await startWorker(contractState, "contract");
  try {
    await runLiveContract(contractWorker);
  } finally {
    await stopWorker(contractWorker);
  }

  phase("MCP Origin parity for static and OAuth access tokens");
  const mcpOriginState = await cloneState(freshState, "mcp-origins");
  await testMcpOriginParity(mcpOriginState);

  phase("KD-31 merge target-folder priority and oldest-live fallback");
  const kd31State = await cloneState(freshState, "kd31-merge");
  await testMergeDuplicateSelection(kd31State, freshConfig);

  phase("live Worker source fixture and JSON/CSV/HTML exports");
  const sourceState = await cloneState(freshState, "source-a");
  const sourceWorker = await startWorker(sourceState, "source-a");
  let exports;
  try {
    const token = await login(sourceWorker);
    await createFixture(sourceWorker, token);
    const jsonResponse = await request(
      sourceWorker,
      "GET",
      "/api/v1/backup/export?format=json",
      { token },
    );
    assert.equal(jsonResponse.status, 200, jsonResponse.text);
    assertFixture(jsonResponse.json, "source A");
    exports = {
      json: JSON.stringify(jsonResponse.json),
      csv: await exportBackup(sourceWorker, token, "csv"),
      html: await exportBackup(sourceWorker, token, "html"),
    };
  } finally {
    await stopWorker(sourceWorker);
  }

  phase("insert/swap D1 rollback with complete pre-state equality");
  await testAtomicFailures(sourceState, exports.json);

  phase("size-independent atomic JSON/CSV/HTML restores above 900 legacy statements");
  const largeRestoreState = await cloneState(freshState, "large-restores");
  await testLargeAtomicRestores(largeRestoreState, freshConfig);

  phase("clean-instance JSON/CSV/HTML A-to-B fidelity");
  const destinations = {};
  for (const format of ["json", "csv", "html"]) {
    destinations[format] = await cloneState(freshState, `destination-${format}`);
    await importAndAssert(destinations[format], format, exports[format]);
  }

  phase("strict share expiry and public resolution");
  const securityWorker = await startWorker(destinations.json, "security-expiry");
  try {
    const unauthenticated = await request(securityWorker, "GET", "/api/v1/bookmarks");
    assert.equal(unauthenticated.status, 401, unauthenticated.text);
    const token = await login(securityWorker);
    await testExpiry(securityWorker, token);
    await testShareUnlockThrottle(securityWorker, token);
    const queryPassword = await request(
      securityWorker,
      "GET",
      "/api/v1/shares/not-a-token?password=secret",
    );
    assert.equal(queryPassword.status, 400, queryPassword.text);
  } finally {
    await stopWorker(securityWorker);
  }

  phase("per-case destructive import rejection equality and valid-empty restore");
  await testMalformedImports(destinations.json);

  phase("scheduled board incremental annotation and watermark advancement");
  const scheduledBoardState = await cloneState(freshState, "scheduled-board");
  await testScheduledBoardIncremental(scheduledBoardState, freshConfig);

  phase("scheduled child-first stale-folder GC");
  await seedAndTestCronGc(destinations.json, freshConfig);

  console.log("worker-d1-runtime: PASS");
}

try {
  await main();
} finally {
  const cleanupErrors = [];
  for (const worker of [...activeWorkers]) {
    await stopWorker(worker).catch((error) => {
      console.error(`worker cleanup failed: ${error.message}`);
      cleanupErrors.push(error);
    });
  }
  await fs.rm(TEMP_ROOT, { recursive: true, force: true });
  const cleaned = await fs.access(TEMP_ROOT).then(
    () => false,
    () => true,
  );
  assert.equal(cleaned, true, `disposable store cleanup failed: ${TEMP_ROOT}`);
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, "one or more owned Workers failed to stop");
  }
}
