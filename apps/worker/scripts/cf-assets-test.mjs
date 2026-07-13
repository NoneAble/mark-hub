import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForPortsReleased } from "./port-release.mjs";

import { buildTempSpa } from "./build-temp-spa.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const WORKER_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_DIR = path.resolve(WORKER_DIR, "../..");
const REAL_CONFIG = path.join(WORKER_DIR, "wrangler.toml");
const BOUNDED_RUN = path.join(os.homedir(), ".pi/agent/extensions/trio-workflow/bounded-run.mjs");
const TEMP_ROOT = path.join(os.tmpdir(), `markhub-cf-assets-${process.pid}-${randomUUID()}`);
const ADMIN_PASSWORD = "CfAssetHarnessPass-2026";
const JWT_SECRET = "cf-asset-harness-jwt-secret-2026";
const MASTER_KEY = "cf-asset-harness-master-key-2026-long";
const MARKER = `markhub-cf-assets-${randomUUID()}`;
const activeWorkers = new Set();
const usedPorts = new Set();

function phase(message) {
  console.log(`cf-assets: ${message}`);
}

function spawnBounded(command, args, options = {}) {
  return spawn(
    process.execPath,
    [
      BOUNDED_RUN,
      "--timeout-ms",
      String(options.timeoutMs || 90_000),
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
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
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

function wrangler(args, options = {}) {
  return runBounded("pnpm", ["exec", "wrangler", ...args], {
    cwd: WORKER_DIR,
    timeoutMs: options.timeoutMs || 120_000,
    env: {
      CI: "1",
      WRANGLER_LOG_PATH: path.join(TEMP_ROOT, "wrangler-logs"),
      ...(options.env || {}),
    },
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

async function readRealConfig() {
  const repoPython = path.join(REPO_DIR, "server/.venv/bin/python");
  const python = fsSync.existsSync(repoPython) ? repoPython : "python3";
  const script = [
    "import json, sys, tomllib",
    "with open(sys.argv[1], 'rb') as handle:",
    "    json.dump(tomllib.load(handle), sys.stdout)",
  ].join("\n");
  const { stdout } = await runBounded(python, ["-c", script, REAL_CONFIG], {
    timeoutMs: 15_000,
  });
  const config = JSON.parse(stdout);
  assert.equal(path.resolve(WORKER_DIR, config.main), path.join(WORKER_DIR, "src/index.ts"));
  assert.ok(config.compatibility_date, "real config compatibility_date missing");
  const database = config.d1_databases?.find((item) => item.binding === "DB");
  assert.ok(database, "real config DB binding missing");
  assert.equal(path.resolve(WORKER_DIR, database.migrations_dir), path.join(WORKER_DIR, "migrations"));
  assert.equal(config.assets?.binding, "ASSETS", "real config ASSETS binding missing");
  assert.equal(
    path.resolve(WORKER_DIR, config.assets?.directory || ""),
    path.join(REPO_DIR, "apps/web/dist"),
    "real config must point to the production web build",
  );
  assert.equal(
    config.assets?.not_found_handling,
    "single-page-application",
    "real config must retain SPA fallback",
  );
  return { config, database };
}

async function writeRuntimeConfig(real, database, webDist) {
  const runtimeConfig = {
    $schema: path.join(WORKER_DIR, "node_modules/wrangler/config-schema.json"),
    name: `${real.name}-asset-harness-${randomUUID().slice(0, 8)}`,
    main: path.join(WORKER_DIR, real.main),
    compatibility_date: real.compatibility_date,
    compatibility_flags: real.compatibility_flags,
    d1_databases: [
      {
        ...database,
        migrations_dir: path.resolve(WORKER_DIR, database.migrations_dir),
      },
    ],
    assets: { ...real.assets, directory: webDist },
    vars: {
      ...(real.vars || {}),
      DEFAULT_ADMIN_PASSWORD: ADMIN_PASSWORD,
      JWT_SECRET,
      MARKHUB_MASTER_KEY: MASTER_KEY,
    },
    triggers: real.triggers,
  };
  const configPath = path.join(TEMP_ROOT, "wrangler.jsonc");
  await fs.writeFile(configPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");
  return configPath;
}

async function startWorker(configPath, stateDir) {
  const port = await freePort();
  const inspectorPort = await freePort();
  await waitForPortsReleased([port, inspectorPort]);
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
      "--log-level",
      "warn",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: WORKER_DIR,
      timeoutMs: 150_000,
      env: { CI: "1", WRANGLER_LOG_PATH: path.join(TEMP_ROOT, "wrangler-logs") },
    },
  );
  const worker = { child, port, inspectorPort, logs: "", stopped: false };
  activeWorkers.add(worker);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (worker.logs += chunk));
  child.stderr.on("data", (chunk) => (worker.logs += chunk));
  return worker;
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

async function verifyEndpoints(worker) {
  const deadline = Date.now() + 25_000;
  let lastError = "not ready";
  while (Date.now() < deadline && worker.child.exitCode === null) {
    try {
      const healthResponse = await fetch(`http://127.0.0.1:${worker.port}/api/v1/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      const health = await healthResponse.json();
      if (!healthResponse.ok || health.status !== "ok" || health.service !== "markhub-worker") {
        throw new Error(`unexpected health: ${JSON.stringify(health)}`);
      }
      const spaResponse = await fetch(`http://127.0.0.1:${worker.port}/admin/login`, {
        signal: AbortSignal.timeout(2_000),
      });
      const spa = await spaResponse.text();
      assert.equal(spaResponse.status, 200);
      assert.match(spaResponse.headers.get("content-type") || "", /text\/html/);
      assert.ok(spa.includes(MARKER), "temporary SPA marker was not served");
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Worker readiness failed: ${lastError}\n${worker.logs}`);
}

async function main() {
  assert.ok(fsSync.existsSync(BOUNDED_RUN), `bounded-run missing: ${BOUNDED_RUN}`);
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const webDist = path.join(TEMP_ROOT, "web-dist");
  const stateDir = path.join(TEMP_ROOT, "d1-state");
  const dryRunDir = path.join(TEMP_ROOT, "dry-run");
  let worker;
  try {
    phase("building temporary SPA assets");
    await buildTempSpa(webDist, MARKER);

    phase("validating checked-in production config");
    const { config: real, database } = await readRealConfig();
    await wrangler([
      "deploy",
      "--dry-run",
      "--config",
      REAL_CONFIG,
      "--assets",
      webDist,
      "--outdir",
      dryRunDir,
    ]);
    const dryRunFiles = await fs.readdir(dryRunDir);
    assert.ok(dryRunFiles.some((name) => name.endsWith(".js")), "real-config dry run emitted no Worker bundle");

    const configPath = await writeRuntimeConfig(real, database, webDist);
    phase("applying disposable local D1 migrations");
    await wrangler([
      "d1",
      "migrations",
      "apply",
      "DB",
      "--config",
      configPath,
      "--local",
      "--persist-to",
      stateDir,
    ]);
    const migrationProbe = await wrangler([
      "d1",
      "execute",
      "DB",
      "--config",
      configPath,
      "--local",
      "--persist-to",
      stateDir,
      "--command",
      "SELECT COUNT(*) AS count FROM d1_migrations",
      "--json",
    ]);
    const rows = JSON.parse(migrationProbe.stdout);
    assert.ok(Number(rows[0]?.results?.[0]?.count) >= 1, "D1 migration ledger is empty");

    phase("starting production-shaped Worker");
    worker = await startWorker(configPath, stateDir);
    await verifyEndpoints(worker);
    phase("SPA marker and API health passed");
  } finally {
    await stopWorker(worker);
    for (const active of [...activeWorkers]) await stopWorker(active);
    await fs.rm(TEMP_ROOT, { recursive: true, force: true });
  }
  assert.equal(activeWorkers.size, 0, "owned Worker set was not emptied");
  phase("exact temporary resources cleaned");
}

if (process.env.MARKHUB_CF_ASSETS_BOUNDED !== "1") {
  assert.ok(fsSync.existsSync(BOUNDED_RUN), `bounded-run missing: ${BOUNDED_RUN}`);
  const result = spawnSync(
    process.execPath,
    [
      BOUNDED_RUN,
      "--timeout-ms",
      "240000",
      "--kill-after-ms",
      "10000",
      "--",
      process.execPath,
      SCRIPT_PATH,
    ],
    {
      cwd: REPO_DIR,
      env: { ...process.env, MARKHUB_CF_ASSETS_BOUNDED: "1" },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} else {
  await main();
}
