/**
 * Pure schedule helpers shared by Worker cron logic (RQG-CF-SCHEDULE-001).
 * Asia/Shanghai is UTC+8 year-round.
 */

export function shanghaiHHmm(d = new Date()): string {
  const ms = d.getTime() + 8 * 3600_000;
  const x = new Date(ms);
  const hh = String(x.getUTCHours()).padStart(2, "0");
  const mm = String(x.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * True when `now` falls in the 15-minute cron window containing configured HH:mm,
 * and no successful backup has run yet that Shanghai calendar day.
 */
export function shouldRunBackup(
  backupTime: string,
  lastBackupAt: string | null | undefined,
  nowDate = new Date(),
): boolean {
  const target = (backupTime || "02:00").slice(0, 5);
  const [th, tm] = target.split(":").map((x) => Number(x));
  if (!Number.isFinite(th) || !Number.isFinite(tm)) return false;
  const targetMinutes = th * 60 + tm;
  const current = shanghaiHHmm(nowDate);
  const [ch, cm] = current.split(":").map((x) => Number(x));
  const currentMinutes = ch * 60 + cm;
  const windowStart = Math.floor(targetMinutes / 15) * 15;
  if (currentMinutes < windowStart || currentMinutes >= windowStart + 15) return false;
  if (!lastBackupAt) return true;
  const last = new Date(lastBackupAt);
  const nowSh = new Date(nowDate.getTime() + 8 * 3600_000);
  const lastSh = new Date(last.getTime() + 8 * 3600_000);
  return (
    nowSh.getUTCFullYear() !== lastSh.getUTCFullYear() ||
    nowSh.getUTCMonth() !== lastSh.getUTCMonth() ||
    nowSh.getUTCDate() !== lastSh.getUTCDate()
  );
}
