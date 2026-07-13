import { describe, expect, it } from "vitest";
import { shouldRunBackup, shanghaiHHmm } from "../src/schedule.js";

describe("shouldRunBackup 15-minute windows (RQG-CF-SCHEDULE-001)", () => {
  // 2026-07-13 02:07 UTC+8 = 2026-07-12 18:07 UTC
  const inWindow = new Date("2026-07-12T18:07:00.000Z");
  // 02:20 Shanghai — outside 02:00–02:14 window
  const outsideWindow = new Date("2026-07-12T18:20:00.000Z");

  it("runs when current Shanghai time is in the target 15-min bucket", () => {
    expect(shouldRunBackup("02:07", null, inWindow)).toBe(true);
    expect(shouldRunBackup("02:00", null, inWindow)).toBe(true);
    expect(shouldRunBackup("02:14", null, inWindow)).toBe(true);
  });

  it("does not run outside the 15-minute bucket (old hourly cron failure mode)", () => {
    // Previously only exact HH:mm match on hourly cron worked; 02:07 never matched :00.
    expect(shouldRunBackup("02:07", null, outsideWindow)).toBe(false);
    expect(shouldRunBackup("03:00", null, inWindow)).toBe(false);
  });

  it("is idempotent within the same Shanghai day after last_backup_at", () => {
    expect(shouldRunBackup("02:07", "2026-07-12T18:05:00.000Z", inWindow)).toBe(false);
  });

  it("runs again on a later Shanghai calendar day", () => {
    const nextDay = new Date("2026-07-13T18:07:00.000Z"); // 2026-07-14 02:07 +8
    expect(shouldRunBackup("02:07", "2026-07-12T18:05:00.000Z", nextDay)).toBe(true);
  });

  it("shanghaiHHmm is UTC+8", () => {
    expect(shanghaiHHmm(new Date("2026-07-12T18:07:00.000Z"))).toBe("02:07");
  });
});
