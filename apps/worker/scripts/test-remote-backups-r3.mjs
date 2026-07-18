#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createFakeRemoteProvider } from "../../../scripts/fake-remote-provider-r3.mjs";
import { waitForPortReleased } from "./port-release.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(HERE, "..");
const WRANGLER = path.join(WORKER_DIR, "node_modules", ".bin", "wrangler");
const REPO_DIR = path.resolve(WORKER_DIR, "..", "..");
const BOUNDED_RUN =
  process.env.BOUNDED_RUN_MJS ||
  path.join(REPO_DIR, "scripts", "lib", "bounded-run.mjs");
const OLD_PASSWORD = "WorkerBackupPass12345";
const NEW_PASSWORD = "WorkerBackupPassChanged12345";
const children = new Set();
let provider;
let tempDir;
let cleaning = false;
let providerPort;
let workerPort;

async function reservePort(excluded = new Set()) {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const port = randomInt(49_152, 65_536);
    if (excluded.has(port)) continue;
    const available = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE") resolve(false);
        else reject(error);
      });
      server.listen(port, "127.0.0.1", () =>
        server.close((error) => (error ? reject(error) : resolve(true))),
      );
    });
    if (available) return port;
  }
  throw new Error("could not preflight an available high loopback port");
}

function signalChild(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  signalChild(child, "SIGTERM");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let forceTimer;
  const forced = new Promise((resolve) =>
    (forceTimer = setTimeout(() => {
      signalChild(child, "SIGKILL");
      resolve();
    }, 3_000)),
  );
  await Promise.race([exited, forced]);
  clearTimeout(forceTimer);
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  await Promise.all([...children].map(stopChild));
  if (provider) await provider.close();
  if (workerPort) await waitForPortReleased(workerPort);
  if (providerPort) await waitForPortReleased(providerPort);
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}

function startChild(args, { timeoutMs, longRunning = false } = {}) {
  const deadline = timeoutMs || 115_000;
  const child = spawn(process.execPath, [
    BOUNDED_RUN,
    "--timeout-ms",
    String(deadline),
    "--kill-after-ms",
    "3000",
    "--",
    WRANGLER,
    ...args,
  ], {
    cwd: WORKER_DIR,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  if (longRunning) return child;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signalChild(child, "SIGTERM");
      reject(new Error(`command timed out after ${deadline + 5_000}ms: wrangler ${args.join(" ")}`));
    }, deadline + 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`wrangler exited code=${code} signal=${signal}`));
    });
  });
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`readiness timed out for ${url}: ${lastError}`);
}

async function api(base, method, pathname, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { response, text, body: parsed };
}

function shanghaiHHmm() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
}

/**
 * An HH:mm guaranteed OUTSIDE the current 15-minute Shanghai window: 30 min
 * ahead (mod day) can never share a floor(15) window with "now", even if the
 * trigger fires a minute later or the offset wraps past midnight.
 */
function shanghaiMismatchHHmm() {
  const [hh, mm] = shanghaiHHmm().split(":").map(Number);
  const total = (hh * 60 + mm + 30) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Dispatch the real cron entrypoint. The legacy `/__scheduled` path is now
 * swallowed by the SPA asset fallback (compat date >= 2025-04-01 with
 * run_worker_first limited to /api/*), so use workerd's scheduled handler
 * endpoint, which `wrangler dev --test-scheduled` exposes on the same port.
 */
async function triggerScheduled(base) {
  const response = await fetch(`${base}/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*`, {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, await response.text());
}

/**
 * Rewind the persisted s3_config.last_backup_at to a past Shanghai day.
 * shouldRunBackup fires at most once per Asia/Shanghai calendar day and the
 * REST API never accepts last_backup_at, so scheduled-run tests reset the
 * day-guard directly in D1 (same --persist-to sqlite; cross-process writes
 * are visible to the running dev server immediately).
 */
async function rewindS3LastBackupAt() {
  await startChild(
    [
      "d1",
      "execute",
      "markhub",
      "--local",
      "--persist-to",
      tempDir,
      "--command",
      "UPDATE settings SET value = json_set(value, '$.last_backup_at', '2020-01-01T00:00:00.000Z') WHERE key = 's3_config'",
    ],
    { timeoutMs: 30_000 },
  );
}

async function login(base) {
  let result = await api(base, "POST", "/api/v1/auth/login", {
    body: { username: "admin", password: OLD_PASSWORD },
  });
  assert.equal(result.response.status, 200, result.text);
  let token = result.body.access_token;
  if (result.body.must_change_password) {
    result = await api(base, "PUT", "/api/v1/auth/credentials", {
      token,
      body: { current_password: OLD_PASSWORD, new_password: NEW_PASSWORD },
    });
    assert.equal(result.response.status, 200, result.text);
    result = await api(base, "POST", "/api/v1/auth/login", {
      body: { username: "admin", password: NEW_PASSWORD },
    });
    assert.equal(result.response.status, 200, result.text);
    token = result.body.access_token;
  }
  return token;
}

async function testWebdav(base, providerUrl, token) {
  let result = await api(base, "PUT", "/api/v1/backup/webdav", {
    token,
    body: {
      enabled: true,
      url: providerUrl,
      username: "fake-user",
      password: "fake-password",
      path: "markhub-backup/",
      keep_backups: 2,
      backup_time: shanghaiHHmm(),
    },
  });
  assert.equal(result.response.status, 200, result.text);

  result = await api(base, "GET", "/api/v1/backup/webdav?test=true", { token });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.body.ok, true, result.text);

  provider.reset({
    webdav_files: [
      "markhub-backup/markhub-backup-2020-01-01-00-00-01.json",
      "markhub-backup/markhub-backup-2020-01-01-00-00-02.json",
      "markhub-backup/markhub-backup-2020-01-01-00-00-03.json",
    ],
  });
  await triggerScheduled(base);
  const afterSchedule = provider.snapshot();
  assert.equal(afterSchedule.webdav_files.length, 2, JSON.stringify(afterSchedule));
  assert.ok(
    afterSchedule.requests.some((request) => request.provider === "webdav" && request.method === "PUT"),
    JSON.stringify(afterSchedule.requests),
  );

  // Partial retention failure with TWO distinct failing keys: the structured
  // response must identify each one (MH-BACKUP-001). Seed 4, upload makes 5,
  // keep 2 -> candidates 03/02/01; 02 and 01 are injected to fail.
  provider.reset({
    webdav_files: [
      "markhub-backup/markhub-backup-2020-01-01-00-00-01.json",
      "markhub-backup/markhub-backup-2020-01-01-00-00-02.json",
      "markhub-backup/markhub-backup-2020-01-01-00-00-03.json",
      "markhub-backup/markhub-backup-2020-01-01-00-00-04.json",
    ],
    fail_webdav_delete: [
      "markhub-backup-2020-01-01-00-00-02.json",
      "markhub-backup-2020-01-01-00-00-01.json",
    ],
  });
  result = await api(base, "POST", "/api/v1/backup/webdav", { token });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.body.ok, true, result.text);
  assert.equal(result.body.retention_ok, false, result.text);
  assert.equal(result.body.pruned, 1, result.text);
  assert.equal(result.body.attempted, 3, result.text);
  assert.equal(result.body.failed, 2, result.text);
  assert.match(result.body.retention_error, /delete failed \(2\)/);
  assert.match(result.body.retention_error, /HTTP 503/);
  assert.deepEqual(
    result.body.retention_failures.map((failure) => failure.key),
    [
      "markhub-backup-2020-01-01-00-00-02.json",
      "markhub-backup-2020-01-01-00-00-01.json",
    ],
    result.text,
  );
  for (const failure of result.body.retention_failures) {
    assert.match(failure.message, /HTTP 503/, result.text);
  }
  assert.equal(provider.snapshot().webdav_files.length, 4, JSON.stringify(provider.snapshot()));

  // Persisted status must survive into GET (MH-BACKUP-002).
  result = await api(base, "GET", "/api/v1/backup/webdav", { token });
  assert.equal(result.response.status, 200, result.text);
  assert.match(result.body.last_retention_error, /delete failed \(2\)/);
  assert.equal(result.body.last_retention_failed, 2, result.text);
  assert.match(result.body.last_retention_error_at, /^\d{4}-\d{2}-\d{2}T/);
  console.log("ok worker WebDAV connection/upload/retention/partial-delete/scheduled");
}

function s3Objects(count) {
  return Array.from({ length: count }, (_, index) => ({
    key: `markhub-backup/markhub-backup-2020-01-01-00-00-0${index + 1}.json`,
    last_modified: `2020-01-0${index + 1}T00:00:00.000Z`,
  }));
}

async function testS3(base, providerUrl, token) {
  let result = await api(base, "PUT", "/api/v1/backup/s3", {
    token,
    body: {
      enabled: true,
      endpoint: providerUrl,
      region: "us-east-1",
      bucket: "markhub-test",
      key_prefix: "markhub-backup/",
      access_key_id: "fake-access-key",
      secret_access_key: "fake-secret-key",
      keep_backups: 2,
      backup_time: "02:00",
      force_path_style: true,
    },
  });
  assert.equal(result.response.status, 200, result.text);

  result = await api(base, "GET", "/api/v1/backup/s3?test=true", { token });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.body.ok, true, result.text);

  provider.reset({ bucket: "markhub-test", s3_objects: s3Objects(2) });
  result = await api(base, "POST", "/api/v1/backup/s3", { token });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.body.retention_ok, true, result.text);
  assert.equal(result.body.pruned, 1, result.text);
  assert.equal(result.body.attempted, 1, result.text);
  assert.equal(result.body.failed, 0, result.text);
  assert.equal(result.body.retention_failures, undefined, result.text);
  assert.equal(provider.snapshot().s3_objects.length, 2);
  console.log("ok worker fake-S3 success");

  provider.reset({ bucket: "markhub-test", s3_objects: s3Objects(2), fail_s3_put: true });
  result = await api(base, "POST", "/api/v1/backup/s3", { token });
  assert.equal(result.response.status, 400, result.text);
  assert.equal(result.body.error.code, "s3_network", result.text);
  assert.equal(provider.snapshot().s3_objects.length, 2);
  assert.ok(!provider.snapshot().requests.some((request) => request.method === "DELETE"));
  console.log("ok worker fake-S3 upload failure");

  // Partial retention failure with TWO distinct failing keys (MH-BACKUP-001):
  // seed 4, upload makes 5, keep 2 -> candidates 03/02/01; 02 and 01 fail.
  provider.reset({
    bucket: "markhub-test",
    s3_objects: s3Objects(4),
    fail_s3_delete: [
      "markhub-backup/markhub-backup-2020-01-01-00-00-02.json",
      "markhub-backup/markhub-backup-2020-01-01-00-00-01.json",
    ],
  });
  result = await api(base, "POST", "/api/v1/backup/s3", { token });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.body.ok, true, result.text);
  assert.equal(result.body.retention_ok, false, result.text);
  assert.equal(result.body.pruned, 1, result.text);
  assert.equal(result.body.attempted, 3, result.text);
  assert.equal(result.body.failed, 2, result.text);
  assert.match(result.body.retention_error, /delete failed \(2\)/);
  assert.match(result.body.retention_error, /S3 DELETE failed: HTTP 503/);
  assert.deepEqual(
    result.body.retention_failures.map((failure) => failure.key),
    [
      "markhub-backup/markhub-backup-2020-01-01-00-00-02.json",
      "markhub-backup/markhub-backup-2020-01-01-00-00-01.json",
    ],
    result.text,
  );
  for (const failure of result.body.retention_failures) {
    assert.match(failure.message, /S3 DELETE failed: HTTP 503/, result.text);
  }
  assert.equal(provider.snapshot().s3_objects.length, 4);

  // Persisted status must survive into GET (MH-BACKUP-002).
  const uploadedKey = result.body.key;
  result = await api(base, "GET", "/api/v1/backup/s3", { token });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.body.last_backup_key, uploadedKey, result.text);
  assert.match(result.body.last_retention_error, /delete failed \(2\)/);
  assert.equal(result.body.last_retention_failed, 2, result.text);
  assert.match(result.body.last_retention_error_at, /^\d{4}-\d{2}-\d{2}T/);
  console.log("ok worker fake-S3 partial delete failure/count/status");
}

/**
 * Scheduled S3 coverage (MH-BACKUP-003): the REAL cron entrypoint must upload,
 * list, prune and persist status — not just the run-now POST path.
 */
async function testS3Scheduled(base, token) {
  // The WebDAV stage leaves its config enabled with today's backup_time. Its
  // once-per-Shanghai-day guard would normally keep it quiet here, but if the
  // suite straddles Shanghai midnight it would fire again — disable it so the
  // scheduled runs below exercise ONLY the S3 branch.
  let result = await api(base, "PUT", "/api/v1/backup/webdav", {
    token,
    body: { enabled: false },
  });
  assert.equal(result.response.status, 200, result.text);

  // --- scheduled happy path: PUT + listing + retention prune + persisted status ---
  result = await api(base, "GET", "/api/v1/backup/s3", { token });
  assert.equal(result.response.status, 200, result.text);
  const previousKey = result.body.last_backup_key;
  assert.ok(previousKey, result.text);

  await rewindS3LastBackupAt();
  const seeded = s3Objects(3).map((object) => object.key);
  provider.reset({ bucket: "markhub-test", s3_objects: s3Objects(3) });
  // Set backup_time right before triggering so the current 15-minute window
  // cannot roll over between config write and cron dispatch.
  result = await api(base, "PUT", "/api/v1/backup/s3", {
    token,
    body: { enabled: true, keep_backups: 2, backup_time: shanghaiHHmm() },
  });
  assert.equal(result.response.status, 200, result.text);
  await triggerScheduled(base);

  const afterHappy = provider.snapshot();
  assert.ok(
    afterHappy.requests.some((request) => request.provider === "s3" && request.method === "PUT"),
    JSON.stringify(afterHappy.requests),
  );
  assert.ok(
    afterHappy.requests.some((request) => request.provider === "s3" && request.method === "GET"),
    JSON.stringify(afterHappy.requests),
  );
  assert.equal(
    afterHappy.requests.filter((request) => request.method === "DELETE").length,
    2,
    JSON.stringify(afterHappy.requests),
  );
  assert.ok(
    !afterHappy.requests.some((request) => request.provider === "webdav"),
    JSON.stringify(afterHappy.requests),
  );
  // 3 seeded + 1 scheduled upload, keep 2 -> the two oldest were pruned.
  assert.equal(afterHappy.s3_objects.length, 2, JSON.stringify(afterHappy));
  assert.ok(afterHappy.s3_objects.includes("markhub-backup/markhub-backup-2020-01-01-00-00-03.json"));
  const scheduledKey = afterHappy.s3_objects.find((key) => !seeded.includes(key));
  assert.ok(scheduledKey, JSON.stringify(afterHappy));
  assert.match(scheduledKey, /^markhub-backup\/markhub-backup-.+\.json$/);

  result = await api(base, "GET", "/api/v1/backup/s3", { token });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.body.last_backup_key, scheduledKey, result.text);
  assert.notEqual(result.body.last_backup_key, previousKey, result.text);
  assert.notEqual(result.body.last_backup_at, "2020-01-01T00:00:00.000Z", result.text);
  // A fully successful scheduled run clears the run-now stage's partial-failure marks.
  assert.equal(result.body.last_retention_error, null, result.text);
  assert.equal(result.body.last_retention_error_at, null, result.text);
  assert.equal(result.body.last_retention_failed, null, result.text);
  console.log("ok worker fake-S3 scheduled happy path (PUT/list/prune/persisted status)");

  // --- scheduled time mismatch: outside the 15-minute window nothing runs ---
  await rewindS3LastBackupAt();
  provider.reset({ bucket: "markhub-test", s3_objects: s3Objects(2) });
  result = await api(base, "PUT", "/api/v1/backup/s3", {
    token,
    body: { backup_time: shanghaiMismatchHHmm() },
  });
  assert.equal(result.response.status, 200, result.text);
  await triggerScheduled(base);

  const afterMismatch = provider.snapshot();
  assert.ok(
    !afterMismatch.requests.some((request) => request.method === "PUT"),
    JSON.stringify(afterMismatch.requests),
  );
  assert.equal(afterMismatch.s3_objects.length, 2, JSON.stringify(afterMismatch));
  result = await api(base, "GET", "/api/v1/backup/s3", { token });
  // The rewound day-guard value survives untouched: the run really was skipped.
  assert.equal(result.body.last_backup_at, "2020-01-01T00:00:00.000Z", result.text);
  assert.equal(result.body.last_backup_key, scheduledKey, result.text);
  console.log("ok worker fake-S3 scheduled time-mismatch skip");

  // --- scheduled partial retention failure persists structured status ---
  await rewindS3LastBackupAt();
  provider.reset({
    bucket: "markhub-test",
    s3_objects: s3Objects(4),
    fail_s3_delete: [
      "markhub-backup/markhub-backup-2020-01-01-00-00-02.json",
      "markhub-backup/markhub-backup-2020-01-01-00-00-01.json",
    ],
  });
  result = await api(base, "PUT", "/api/v1/backup/s3", {
    token,
    body: { backup_time: shanghaiHHmm() },
  });
  assert.equal(result.response.status, 200, result.text);
  await triggerScheduled(base);

  const afterPartial = provider.snapshot();
  // 4 seeded + 1 upload, keep 2 -> 3 delete attempts, 2 injected failures.
  assert.equal(
    afterPartial.requests.filter((request) => request.method === "DELETE").length,
    3,
    JSON.stringify(afterPartial.requests),
  );
  assert.equal(afterPartial.s3_objects.length, 4, JSON.stringify(afterPartial));
  result = await api(base, "GET", "/api/v1/backup/s3", { token });
  assert.equal(result.response.status, 200, result.text);
  assert.match(result.body.last_retention_error, /delete failed \(2\)/);
  assert.match(result.body.last_retention_error_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.body.last_retention_failed, 2, result.text);
  assert.notEqual(result.body.last_backup_key, scheduledKey, result.text);
  console.log("ok worker fake-S3 scheduled partial retention failure persisted");

  // A later fully successful backup clears the persisted failure marks. The
  // scheduler only fires once per Shanghai day (the partial run above already
  // consumed today's slot), so the clearing run uses run-now on purpose.
  provider.reset({ bucket: "markhub-test", s3_objects: s3Objects(2) });
  result = await api(base, "POST", "/api/v1/backup/s3", { token });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.body.retention_ok, true, result.text);
  assert.equal(result.body.failed, 0, result.text);
  result = await api(base, "GET", "/api/v1/backup/s3", { token });
  assert.equal(result.body.last_retention_error, null, result.text);
  assert.equal(result.body.last_retention_error_at, null, result.text);
  assert.equal(result.body.last_retention_failed, null, result.text);
  console.log("ok worker fake-S3 scheduled retention-error clearing");
}

async function main() {
  providerPort = await reservePort();
  workerPort = await reservePort(new Set([providerPort]));
  tempDir = await mkdtemp(path.join(os.tmpdir(), "markhub-worker-remote-r3-"));
  provider = createFakeRemoteProvider({ port: providerPort });
  const providerUrl = await provider.start();

  await startChild(
    ["d1", "migrations", "apply", "markhub", "--local", "--persist-to", tempDir],
    { timeoutMs: 30_000 },
  );
  const worker = startChild(
    [
      "dev",
      "--local",
      "--test-scheduled",
      "--ip",
      "127.0.0.1",
      "--port",
      String(workerPort),
      "--persist-to",
      tempDir,
      "--var",
      "JWT_SECRET:test-worker-jwt-secret-r3",
      "--var",
      "MARKHUB_MASTER_KEY:test-worker-master-key-r3-32bytes",
      "--var",
      `DEFAULT_ADMIN_PASSWORD:${OLD_PASSWORD}`,
      "--log-level",
      "warn",
    ],
    // The scheduled-S3 stage adds three cron dispatches plus d1-execute
    // day-guard rewinds, so the dev server's bounded-run budget grew with it.
    { longRunning: true, timeoutMs: 175_000 },
  );
  const base = `http://127.0.0.1:${workerPort}`;
  await waitFor(`${base}/api/v1/health`);
  const token = await login(base);
  await testWebdav(base, providerUrl, token);
  await testS3(base, providerUrl, token);
  await testS3Scheduled(base, token);
  await stopChild(worker);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

let overallTimer;
try {
  const overallTimeout = new Promise((_, reject) => {
    overallTimer = setTimeout(
      () => reject(new Error("remote backup integration timed out after 180000ms")),
      180_000,
    );
  });
  await Promise.race([
    main(),
    overallTimeout,
  ]);
  console.log("worker remote backup integration: PASS");
} finally {
  clearTimeout(overallTimer);
  await cleanup();
}
