// Bindings that exist at runtime but are not declared in wrangler.toml, merged
// into the generated `Env` (worker-configuration.d.ts) by declaration merging:
// secrets come from `wrangler secret put` / .dev.vars, and the failure
// injection binding is set only by the local D1 runtime test harness.
interface Env {
  JWT_SECRET?: string;
  MARKHUB_MASTER_KEY?: string;
  DEFAULT_ADMIN_PASSWORD?: string;
  /** Test-only local binding. Not configured in deployed wrangler environments. */
  RESTORE_TEST_FAIL_PHASE?: string;
  /** Test-only: stall replace_all between staging and cutover (ms, capped 30s). */
  RESTORE_TEST_STALL_MS?: string;
}
