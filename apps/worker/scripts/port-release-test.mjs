import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import net from "node:net";

import { waitForPortsReleased } from "./port-release.mjs";

const usedPorts = new Set();

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

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeAfter(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      server.close((error) => (error ? reject(error) : resolve()));
    }, timeoutMs);
  });
}

const appPort = await freePort();
const inspectorPort = await freePort();
const appListener = await listen(appPort);
const inspectorListener = await listen(inspectorPort);
const appClosed = closeAfter(appListener, 100);
const inspectorClosed = closeAfter(inspectorListener, 200);
const retries = new Map();

try {
  await waitForPortsReleased([appPort, inspectorPort], {
    timeoutMs: 2_000,
    retryIntervalMs: 20,
    onRetry: ({ port }) => retries.set(port, (retries.get(port) || 0) + 1),
  });
  await Promise.all([appClosed, inspectorClosed]);
  assert.ok(retries.get(appPort) > 0, "application port was not retried");
  assert.ok(retries.get(inspectorPort) > 0, "inspector port was not retried");
  console.log("worker port-release regression: PASS");
} finally {
  if (appListener.listening) await new Promise((resolve) => appListener.close(resolve));
  if (inspectorListener.listening) {
    await new Promise((resolve) => inspectorListener.close(resolve));
  }
}
