/**
 * Pure helpers for board full / incremental scan (KD-39).
 */

export interface ScanBookmark {
  id: string;
  url_normalized: string;
  title: string;
  folder_id: string;
  folder_path: string;
  deleted?: boolean;
}

export interface ScanAnnotation {
  id: string;
  bookmark_id: string;
  url_normalized?: string;
  present: boolean;
  status: string;
}

export interface FullScanPlan {
  upserts: Array<{
    bookmark_id: string;
    title: string;
    source_folder_id: string;
    source_folder_path: string;
    is_new: boolean;
    annotation_id?: string;
  }>;
  missing_annotation_ids: string[];
}

export function planFullScan(
  liveBookmarks: ScanBookmark[],
  existing: ScanAnnotation[],
  matchBy: "bookmark_id" | "url_normalized" = "bookmark_id",
): FullScanPlan {
  const byBookmark = new Map(existing.map((a) => [a.bookmark_id, a]));
  const byUrl = new Map(
    existing
      .filter((a) => a.url_normalized)
      .map((a) => [a.url_normalized!, a]),
  );
  const seen = new Set<string>();
  const upserts: FullScanPlan["upserts"] = [];

  for (const b of liveBookmarks) {
    if (b.deleted) continue;
    let ann =
      matchBy === "bookmark_id"
        ? byBookmark.get(b.id)
        : byUrl.get(b.url_normalized) ?? byBookmark.get(b.id);
    if (!ann && matchBy === "bookmark_id") {
      ann = byUrl.get(b.url_normalized);
    }
    if (ann) {
      seen.add(ann.id);
      upserts.push({
        bookmark_id: b.id,
        title: b.title,
        source_folder_id: b.folder_id,
        source_folder_path: b.folder_path,
        is_new: false,
        annotation_id: ann.id,
      });
    } else {
      upserts.push({
        bookmark_id: b.id,
        title: b.title,
        source_folder_id: b.folder_id,
        source_folder_path: b.folder_path,
        is_new: true,
      });
    }
  }

  const missing_annotation_ids = existing
    .filter((a) => !seen.has(a.id) && a.present)
    .map((a) => a.id);

  return { upserts, missing_annotation_ids };
}

export interface OpChange {
  id: number;
  entity_type: string;
  entity_id: string;
  action: string;
  snapshot?: Record<string, unknown> | null;
}

export interface IncrementalScanPlan {
  mode: "incremental" | "full_fallback";
  relevant: OpChange[];
  new_cursor: number | null;
}

/**
 * If watermark is null or lag is too large (op ids span > maxLag), fall back to full.
 */
export function planIncrementalScan(
  changes: OpChange[],
  watermark: number | null,
  options: { maxLag?: number; currentMaxOpId?: number } = {},
): IncrementalScanPlan {
  const maxLag = options.maxLag ?? 50_000;
  const currentMax = options.currentMaxOpId ?? (changes.length ? changes[changes.length - 1]!.id : watermark ?? 0);

  if (watermark == null) {
    return { mode: "full_fallback", relevant: [], new_cursor: currentMax };
  }
  if (currentMax - watermark > maxLag) {
    return { mode: "full_fallback", relevant: [], new_cursor: currentMax };
  }

  const relevant = changes.filter(
    (c) =>
      c.id > watermark &&
      (c.entity_type === "bookmark" ||
        c.entity_type === "folder" ||
        c.entity_type === "reorder"),
  );
  const new_cursor = relevant.length
    ? Math.max(...relevant.map((c) => c.id))
    : watermark;

  return { mode: "incremental", relevant, new_cursor };
}

/** Collect folder ids in a subtree given adjacency list. */
export function collectSubtreeFolderIds(
  rootIds: string[],
  folders: Array<{ id: string; parent_id: string | null; deleted_at?: string | null }>,
): Set<string> {
  const children = new Map<string | null, string[]>();
  for (const f of folders) {
    if (f.deleted_at) continue;
    const list = children.get(f.parent_id) ?? [];
    list.push(f.id);
    children.set(f.parent_id, list);
  }
  const out = new Set<string>();
  const stack = [...rootIds];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return out;
}
