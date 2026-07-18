import { describe, it, expect } from "vitest";
import { validateS3Config } from "../src/s3Config";

describe("validateS3Config", () => {
  it("accepts R2-style config", () => {
    const r = validateS3Config({
      enabled: true,
      endpoint: "https://abc.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "markhub-backups",
      key_prefix: "markhub-backup",
      access_key_id: "AKIA",
      secret_access_key: "secret",
      keep_backups: 7,
      backup_time: "02:00",
    });
    expect(r.ok).toBe(true);
    expect(r.normalized?.key_prefix).toBe("markhub-backup/");
    expect(r.normalized?.force_path_style).toBe(true);
  });

  it("rejects bad endpoint", () => {
    const r = validateS3Config({
      endpoint: "not-a-url",
      bucket: "b",
      access_key_id: "a",
      secret_access_key: "s",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects invalid backup_time and keep_backups", () => {
    expect(
      validateS3Config({
        endpoint: "https://s3.example.com",
        bucket: "valid-bucket",
        access_key_id: "a",
        secret_access_key: "s",
        backup_time: "99:99",
        keep_backups: 7,
      }).ok,
    ).toBe(false);
    expect(
      validateS3Config({
        endpoint: "https://s3.example.com",
        bucket: "valid-bucket",
        access_key_id: "a",
        secret_access_key: "s",
        backup_time: "02:00",
        keep_backups: 0,
      }).ok,
    ).toBe(false);
  });
});
