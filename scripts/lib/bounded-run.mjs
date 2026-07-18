#!/usr/bin/env node
// bounded-run.mjs — self-contained deadline / process-group wrapper.
// Vendored repo-local copy (MH-TEST-003); no external dependencies, Node >= 20.
//
// Usage:
//   node bounded-run.mjs --timeout-ms <N> --kill-after-ms <M> -- <command> [args...]
//
// Behavior:
//   * The command is spawned with inherited stdio in its OWN process group
//     (spawned with detached: true on POSIX), so the entire tree it creates
//     can be signalled at once via kill(-pgid).
//   * On deadline (--timeout-ms elapsed) the wrapper prints
//       "bounded-run: deadline exceeded after <N>ms, killing process group"
//     to stderr, sends SIGTERM to the child's process group, and escalates to
//     SIGKILL on the group if the child is still alive after --kill-after-ms.
//   * SIGINT / SIGTERM / SIGHUP received by the wrapper are forwarded to the
//     child's process group, with the same SIGKILL-after---kill-after-ms
//     escalation.
//   * Signals are only ever sent to the CHILD's group (kill(-child.pid)),
//     never to the wrapper's own group, so nested bounded-run invocations
//     (a bounded child that itself runs bounded-run) are safe.
//
// Exit-code convention (documented, stable):
//   child's exit code — the child exited on its own
//   124               — the deadline fired (whatever signal finally ended the
//                       child); always non-zero
//   128 + signum      — the child was ended by a signal not caused by the
//                       deadline (e.g. 143 for SIGTERM, 130 for SIGINT)
//   127               — the command could not be spawned
//   2                 — usage error

import { spawn } from "node:child_process";
import os from "node:os";
import process from "node:process";

const USAGE =
  "usage: node bounded-run.mjs --timeout-ms <N> --kill-after-ms <M> -- <command> [args...]";

function usageError(message) {
  if (message) process.stderr.write(`bounded-run: ${message}\n`);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

function parsePositiveInteger(flag, value) {
  if (value === undefined || !/^\d+$/.test(value)) {
    usageError(`${flag} requires a non-negative integer, got: ${value}`);
  }
  return Number.parseInt(value, 10);
}

function parseArgs(argv) {
  let timeoutMs;
  let killAfterMs;
  let command = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      command = argv.slice(i + 1);
      break;
    }
    let flag = arg;
    let value;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      flag = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }
    if (flag === "--timeout-ms" || flag === "--kill-after-ms") {
      if (value === undefined) {
        i += 1;
        value = argv[i];
      }
      const parsed = parsePositiveInteger(flag, value);
      if (flag === "--timeout-ms") timeoutMs = parsed;
      else killAfterMs = parsed;
    } else {
      usageError(`unknown argument: ${arg}`);
    }
  }
  if (timeoutMs === undefined) usageError("--timeout-ms is required");
  if (timeoutMs < 1) usageError("--timeout-ms must be >= 1");
  if (killAfterMs === undefined) usageError("--kill-after-ms is required");
  if (command === null) usageError('missing "--" separator before the command');
  if (command.length === 0) usageError("missing command after \"--\"");
  return { timeoutMs, killAfterMs, command };
}

const { timeoutMs, killAfterMs, command } = parseArgs(process.argv.slice(2));

const posix = process.platform !== "win32";
const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  detached: posix,
});

let deadlineFired = false;
let forcedKillTimer = null;
let deadlineTimer = null;

// Guard for nested use: only ever signal the child's own group (-child.pid);
// never signal our own process group.
function signalChildGroup(signal) {
  if (!child.pid) return;
  if (posix) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group already gone (ESRCH) or not signallable; fall through to the
      // direct-child fallback below.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Child already reaped.
  }
}

function scheduleForcedKill() {
  if (forcedKillTimer !== null) return;
  forcedKillTimer = setTimeout(() => {
    signalChildGroup("SIGKILL");
  }, killAfterMs);
}

function clearTimers() {
  if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  if (forcedKillTimer !== null) clearTimeout(forcedKillTimer);
  deadlineTimer = null;
  forcedKillTimer = null;
}

deadlineTimer = setTimeout(() => {
  deadlineFired = true;
  process.stderr.write(
    `bounded-run: deadline exceeded after ${timeoutMs}ms, killing process group\n`,
  );
  signalChildGroup("SIGTERM");
  scheduleForcedKill();
}, timeoutMs);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    signalChildGroup(signal);
    scheduleForcedKill();
  });
}

child.on("error", (error) => {
  clearTimers();
  process.stderr.write(`bounded-run: failed to spawn ${command[0]}: ${error.message}\n`);
  process.exit(127);
});

child.on("exit", (code, signal) => {
  clearTimers();
  if (deadlineFired) process.exit(124);
  if (signal !== null) {
    const signum = os.constants.signals[signal];
    process.exit(typeof signum === "number" ? 128 + signum : 1);
  }
  process.exit(code ?? 1);
});
