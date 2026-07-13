import type { AnnotationStatus } from "./types.js";

/** Neutral status labels (KD-40) — no inventory semantics. */
export const STATUS_LABELS: Record<
  AnnotationStatus,
  { zh: string; en: string }
> = {
  active: { zh: "可用", en: "Active" },
  limited: { zh: "受限", en: "Limited" },
  pending: { zh: "待验证", en: "Pending" },
  watching: { zh: "观察中", en: "Watching" },
  dead: { zh: "失效", en: "Dead" },
  blocked: { zh: "屏蔽", en: "Blocked" },
};

export const ANNOTATION_STATUSES: AnnotationStatus[] = [
  "active",
  "limited",
  "pending",
  "watching",
  "dead",
  "blocked",
];

export function statusLabel(
  status: AnnotationStatus,
  lang: "zh" | "en" = "zh",
): string {
  return STATUS_LABELS[status]?.[lang] ?? status;
}

/** Map legacy Smart-Bookmark inventory-ish statuses if present in imports. */
export function mapLegacyStatus(raw: string | null | undefined): AnnotationStatus {
  if (!raw) return "pending";
  const s = raw.toLowerCase().trim();
  const map: Record<string, AnnotationStatus> = {
    active: "active",
    available: "active",
    ok: "active",
    有货: "active",
    limited: "limited",
    受限: "limited",
    pending: "pending",
    待验证: "pending",
    watching: "watching",
    watch: "watching",
    观察中: "watching",
    dead: "dead",
    失效: "dead",
    下架: "dead",
    blocked: "blocked",
    屏蔽: "blocked",
  };
  return map[s] ?? "pending";
}
