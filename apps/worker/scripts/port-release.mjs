import net from "node:net";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_INTERVAL_MS = 50;

function delay(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function bindAndRelease(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(port, host, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

export async function waitForPortReleased(
  port,
  {
    host = "127.0.0.1",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
    onRetry,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  while (true) {
    attempts += 1;
    try {
      await bindAndRelease(port, host);
      return;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      onRetry?.({ attempts, error, host, port });
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `owned port ${host}:${port} remained bound after ${timeoutMs}ms (${attempts} attempts)`,
          { cause: error },
        );
      }
      await delay(Math.min(retryIntervalMs, remainingMs));
    }
  }
}

export async function waitForPortsReleased(ports, options) {
  await Promise.all(ports.map((port) => waitForPortReleased(port, options)));
}
