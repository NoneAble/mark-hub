import type { S3BackupConfig } from "./types.js";

export interface S3ConfigValidation {
  ok: boolean;
  errors: string[];
  normalized?: Omit<S3BackupConfig, "secret_access_key" | "access_key_id"> & {
    access_key_id: string;
    secret_access_key?: string;
  };
}

/** Appendix B field validation for S3/R2 backup config. */
export function validateS3Config(
  input: Partial<S3BackupConfig>,
  opts: { requireSecrets?: boolean } = {},
): S3ConfigValidation {
  const errors: string[] = [];
  const requireSecrets = opts.requireSecrets !== false;

  const endpoint = (input.endpoint ?? "").trim();
  if (!endpoint) errors.push("endpoint is required");
  else {
    try {
      const u = new URL(endpoint);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        errors.push("endpoint must be http(s) URL");
      }
    } catch {
      errors.push("endpoint must be a valid URL");
    }
  }

  const region = (input.region ?? "").trim() || "auto";
  const bucket = (input.bucket ?? "").trim();
  if (!bucket) errors.push("bucket is required");
  else if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(bucket)) {
    errors.push("bucket name is invalid");
  }

  let key_prefix = (input.key_prefix ?? "").trim();
  key_prefix = key_prefix.replace(/^\/+/, "");
  if (key_prefix && !key_prefix.endsWith("/")) key_prefix += "/";

  const access_key_id = (input.access_key_id ?? "").trim();
  const secret_access_key = input.secret_access_key ?? "";
  if (requireSecrets) {
    if (!access_key_id) errors.push("access_key_id is required");
    if (!secret_access_key) errors.push("secret_access_key is required");
  }

  const keep_backups = Number(input.keep_backups ?? 7);
  if (!Number.isFinite(keep_backups) || keep_backups < 1) {
    errors.push("keep_backups must be >= 1");
  }

  const backup_time = (input.backup_time ?? "02:00").trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(backup_time)) {
    errors.push("backup_time must be HH:mm");
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    normalized: {
      enabled: Boolean(input.enabled),
      endpoint,
      region,
      bucket,
      key_prefix,
      access_key_id,
      secret_access_key: secret_access_key || undefined,
      keep_backups,
      backup_time,
      force_path_style: input.force_path_style !== false,
      last_backup_at: input.last_backup_at,
      last_backup_key: input.last_backup_key,
    },
  };
}
