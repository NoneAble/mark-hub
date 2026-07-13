/** Structured application logs for Workers observability (R3-F014). */

export type LogFields = Record<string, unknown>;

export function logInfo(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ level: "info", event, ts: new Date().toISOString(), ...fields }));
}

export function logWarn(event: string, fields: LogFields = {}): void {
  console.warn(JSON.stringify({ level: "warn", event, ts: new Date().toISOString(), ...fields }));
}

export function logError(event: string, fields: LogFields = {}): void {
  console.error(JSON.stringify({ level: "error", event, ts: new Date().toISOString(), ...fields }));
}

/** In-memory process metrics (reset on isolate recycle). */
export const metrics = {
  requests: 0,
  errors_5xx: 0,
  errors_4xx: 0,
  backup_webdav_ok: 0,
  backup_webdav_fail: 0,
  backup_s3_ok: 0,
  backup_s3_fail: 0,
  board_scan_ok: 0,
  board_scan_fail: 0,
  mcp_calls: 0,
};

/** Shared OpenAPI metrics shape: requests_total aliases in-process request counter. */
export function snapshotMetrics() {
  return {
    ...metrics,
    requests_total: metrics.requests,
  };
}
