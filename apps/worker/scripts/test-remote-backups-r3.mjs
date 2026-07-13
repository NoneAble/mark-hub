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
const BOUNDED_RUN =
  process.env.BOUNDED_RUN_MJS ||
  path.join(os.homedir(), ".pi", "agent", "extensions", "trio-workflow", "bounded-run.mjs");
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
  const scheduled = await fetch(`${base}/__scheduled`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(scheduled.status, 200, await scheduled.text());
  const afterSchedule = provider.snapshot();
  assert.equal(afterSchedule.webdav_files.length, 2, JSON.stringify(afterSchedule));
  assert.ok(
    afterSchedule.requests.some((request) => request.provider === "webdav" && request.method === "PUT"),
    JSON.stringify(afterSchedule.requests),
  );

  provider.reset({
    webdav_files: [
      "markhub-backup/markhub-backup-2020-01-01-00-00-01.json",
      "markhub-backup/markhub-backup-2020-01-01-00-00-02.json",
      "markhub-backup/markhub-backup-2020-01-01-00-00-03.json",
    ],
    fail_webdav_delete: ["markhub-backup-2020-01-01-00-00-02.json"],
  });
  result = await api(base, "POST", "/api/v1/backup/webdav", { token });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.body.ok, true, result.text);
  assert.equal(result.body.retention_ok, false, result.text);
  assert.equal(result.body.pruned, 1, result.text);
  assert.match(result.body.retention_error, /HTTP 503/);
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
  assert.equal(provider.snapshot().s3_objects.length, 2);
  console.log("ok worker fake-S3 success");

  provider.reset({ bucket: "markhub-test", s3_objects: s3Objects(2), fail_s3_put: true });
  result = await api(base, "POST", "/api/v1/backup/s3", { token });
  assert.equal(result.response.status, 400, result.text);
  assert.equal(result.body.error.code, "s3_network", result.text);
  assert.equal(provider.snapshot().s3_objects.length, 2);
  assert.ok(!provider.snapshot().requests.some((request) => request.method === "DELETE"));
  console.log("ok worker fake-S3 upload failure");

  provider.reset({
    bucket: "markhub-test",
    s3_objects: s3Objects(3),
    fail_s3_delete: ["markhub-backup/markhub-backup-2020-01-01-00-00-02.json"],
  });
  result = await api(base, "POST", "/api/v1/backup/s3", { token });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.body.ok, true, result.text);
  assert.equal(result.body.retention_ok, false, result.text);
  assert.equal(result.body.pruned, 1, result.text);
  assert.match(result.body.retention_error, /S3 DELETE failed: HTTP 503/);
  assert.equal(provider.snapshot().s3_objects.length, 3);
  console.log("ok worker fake-S3 partial delete failure/count/status");
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
    { longRunning: true, timeoutMs: 115_000 },
  );
  const base = `http://127.0.0.1:${workerPort}`;
  await waitFor(`${base}/api/v1/health`);
  const token = await login(base);
  await testWebdav(base, providerUrl, token);
  await testS3(base, providerUrl, token);
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
      () => reject(new Error("remote backup integration timed out after 120000ms")),
      120_000,
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
