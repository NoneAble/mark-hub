import { normalizeUrl } from "./normalizeUrl.js";

export type FolderVisibility = "private" | "unlisted" | "public";

/** Supported backup import formats (RQG-F008). */
export const BACKUP_FORMATS = ["json", "csv", "html"] as const;
export type BackupFormat = (typeof BACKUP_FORMATS)[number];

/** Supported restore strategies (RQG-F008). */
export const BACKUP_STRATEGIES = [
  "skip_duplicate",
  "merge",
  "replace_all",
] as const;
export type BackupStrategy = (typeof BACKUP_STRATEGIES)[number];

/** Native MarkHub JSON schema versions currently accepted. */
export const NATIVE_JSON_FORMAT = "markhub-json";
export const NATIVE_JSON_VERSIONS = new Set([1]);

export interface ParsedBookmark {
  title: string;
  url: string;
  url_normalized: string;
  description?: string;
  folder_path: string[]; // path segments under root
  /** Export folder id when present (identity-preserving restore). */
  export_folder_id?: string;
  tags: string[];
  /** Tag name → color from export tag_objects / tags[]. */
  tag_colors?: Record<string, string | null>;
  visibility?: FolderVisibility;
  is_favorite?: boolean;
  is_archived?: boolean;
  sort_order?: number;
  add_date?: number;
}

/** Metadata for a folder path reconstructed from native MarkHub JSON export. */
export interface FolderPathMeta {
  visibility: FolderVisibility;
  sort_order?: number;
  /** Stable export id for identity-preserving restore (duplicate names). */
  export_id?: string;
  parent_export_id?: string | null;
  name?: string;
  is_system?: boolean;
}

/** Root-level tag row from native export (including unassociated tags). */
export interface ParsedTag {
  name: string;
  color?: string | null;
  export_id?: string;
}

/**
 * Encode path segments into an unambiguous map key.
 *
 * Slash-joined keys corrupt legal folder names containing `/` (RQG-BACKUP-001).
 * JSON array encoding preserves each segment byte-for-byte.
 */
export function encodeFolderPathKey(segments: readonly string[]): string {
  return JSON.stringify(segments.map(String));
}

/** Decode a key produced by {@link encodeFolderPathKey}. */
export function decodeFolderPathKey(key: string): string[] {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(String);
  } catch {
    return [];
  }
}

/** Normalize tag field from export: string names, objects with name, or CSV string. */
export function normalizeTagNames(tags: unknown): string[] {
  if (Array.isArray(tags)) {
    return tags
      .map((t) => {
        if (typeof t === "string") return t.trim();
        if (t && typeof t === "object" && "name" in t) {
          return String((t as { name: unknown }).name || "").trim();
        }
        return "";
      })
      .filter(Boolean);
  }
  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

/** Extract name→color map from tag objects / dual export forms. */
export function normalizeTagColors(
  tags: unknown,
  tagObjects?: unknown,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const consume = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const t of list) {
      if (t && typeof t === "object" && "name" in t) {
        const name = String((t as { name: unknown }).name || "").trim();
        if (!name) continue;
        const color =
          "color" in t && (t as { color: unknown }).color != null
            ? String((t as { color: unknown }).color)
            : null;
        out[name] = color;
      }
    }
  };
  consume(tagObjects);
  consume(tags);
  return out;
}

export function isBackupFormat(v: unknown): v is BackupFormat {
  return typeof v === "string" && (BACKUP_FORMATS as readonly string[]).includes(v);
}

export function isBackupStrategy(v: unknown): v is BackupStrategy {
  return (
    typeof v === "string" && (BACKUP_STRATEGIES as readonly string[]).includes(v)
  );
}

/**
 * Normalize and validate import format/strategy (RQG-F008).
 * Throws never — returns error strings for callers to reject before mutation.
 */
export function validateImportOptions(opts: {
  format?: unknown;
  strategy?: unknown;
}): { format: BackupFormat; strategy: BackupStrategy; errors: string[] } {
  const errors: string[] = [];
  const rawFormat =
    typeof opts.format === "string" ? opts.format.trim().toLowerCase() : "json";
  const rawStrategy =
    typeof opts.strategy === "string"
      ? opts.strategy.trim()
      : "skip_duplicate";
  if (!isBackupFormat(rawFormat)) {
    errors.push(`unsupported format: ${String(opts.format)}`);
  }
  if (!isBackupStrategy(rawStrategy)) {
    errors.push(`unsupported strategy: ${String(opts.strategy)}`);
  }
  return {
    format: (isBackupFormat(rawFormat) ? rawFormat : "json") as BackupFormat,
    strategy: (isBackupStrategy(rawStrategy)
      ? rawStrategy
      : "skip_duplicate") as BackupStrategy,
    errors,
  };
}

type ExportFolderRow = {
  id?: string;
  parent_id?: string | null;
  name?: string;
  is_system?: boolean | number;
  visibility?: string;
  sort_order?: number | string;
};

function asFolderVisibility(v: unknown): FolderVisibility {
  return v === "public" || v === "unlisted" || v === "private" ? v : "private";
}

function asOptionalInt(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function truthyFlag(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true" || v === "True";
}

/**
 * Build folder_id → path segments from a folders array (MarkHub JSON export).
 * System folders are omitted from paths (bookmarks under inbox → []).
 */
export function folderPathsFromExport(
  folders: ExportFolderRow[],
): Map<string, string[]> {
  const byId = new Map(
    folders
      .filter((f) => f && f.id)
      .map((f) => [String(f.id), f] as const),
  );
  const cache = new Map<string, string[]>();
  const pathOf = (id: string, seen = new Set<string>()): string[] => {
    if (cache.has(id)) return cache.get(id)!;
    if (seen.has(id)) return [];
    seen.add(id);
    const f = byId.get(id);
    if (!f || f.is_system) {
      cache.set(id, []);
      return [];
    }
    const parent = f.parent_id ? pathOf(String(f.parent_id), seen) : [];
    const parts = [...parent, String(f.name || "")].filter(Boolean);
    cache.set(id, parts);
    return parts;
  };
  for (const id of byId.keys()) pathOf(id);
  return cache;
}

/**
 * Map encoded path key → folder metadata from native export folders[] (RQG-BACKUP-001).
 * Keys are {@link encodeFolderPathKey} values so names may contain `/`.
 * Enables restore to recreate nested folders with original visibility.
 *
 * When duplicate same-parent same-name folders exist, path keys alone collide;
 * callers should prefer {@link folderIdentityMetaFromExport} for identity restore.
 */
export function folderPathMetaFromExport(
  folders: ExportFolderRow[],
): Map<string, FolderPathMeta> {
  const paths = folderPathsFromExport(folders);
  const byId = new Map(
    folders
      .filter((f) => f && f.id)
      .map((f) => [String(f.id), f] as const),
  );
  const meta = new Map<string, FolderPathMeta>();
  for (const [fid, segs] of paths) {
    if (!segs.length) continue;
    const key = encodeFolderPathKey(segs);
    const f = byId.get(fid);
    // Last-write on path collision preserves at least one row's meta;
    // identity map below is authoritative for duplicates.
    meta.set(key, {
      visibility: asFolderVisibility(f?.visibility),
      sort_order: asOptionalInt(f?.sort_order),
      export_id: fid,
      parent_export_id:
        f?.parent_id != null && f.parent_id !== ""
          ? String(f.parent_id)
          : null,
      name: f?.name != null ? String(f.name) : undefined,
      is_system: !!f?.is_system,
    });
  }
  return meta;
}

/**
 * Identity-preserving folder metadata keyed by export folder id (RQG-F003).
 * Survives same-parent same-name duplicates that path keys collapse.
 */
export function folderIdentityMetaFromExport(
  folders: ExportFolderRow[],
): Map<string, FolderPathMeta> {
  const meta = new Map<string, FolderPathMeta>();
  for (const f of folders) {
    if (!f?.id) continue;
    if (f.is_system) continue;
    const id = String(f.id);
    meta.set(id, {
      visibility: asFolderVisibility(f.visibility),
      sort_order: asOptionalInt(f.sort_order),
      export_id: id,
      parent_export_id:
        f.parent_id != null && f.parent_id !== ""
          ? String(f.parent_id)
          : null,
      name: String(f.name || ""),
      is_system: false,
    });
  }
  return meta;
}

export interface ParseResult {
  bookmarks: ParsedBookmark[];
  folders: string[][]; // unique folder paths (segment arrays)
  /**
   * Encoded path key ({@link encodeFolderPathKey}) → metadata from native folders[].
   * Empty for CSV/HTML without path meta.
   */
  folder_meta: Map<string, FolderPathMeta>;
  /** Export folder id → metadata (identity-preserving; native JSON). */
  folder_by_export_id: Map<string, FolderPathMeta>;
  /** Root tags[] including unassociated tags with colors. */
  tags: ParsedTag[];
  errors: string[];
}

function emptyResult(errors: string[] = []): ParseResult {
  return {
    bookmarks: [],
    folders: [],
    folder_meta: new Map(),
    folder_by_export_id: new Map(),
    tags: [],
    errors,
  };
}

/** Parse Netscape HTML bookmark export (incl. MarkHub visibility/tag extensions). */
export function parseNetscapeHtml(html: string): ParseResult {
  const bookmarks: ParsedBookmark[] = [];
  const folderSet = new Set<string>();
  const errors: string[] = [];
  const folder_meta = new Map<string, FolderPathMeta>();
  const stack: string[] = [];
  const visStack: FolderVisibility[] = [];

  // Lightweight line-oriented parser (works for Chrome/Firefox/MarkHub exports)
  const lines = html.split(/\r?\n/);
  for (const line of lines) {
    const folderMatch = line.match(/<H3([^>]*)>([^<]*)<\/H3>/i);
    if (folderMatch) {
      const attrs = folderMatch[1] || "";
      const name = decodeEntities((folderMatch[2] || "").trim());
      if (name) {
        stack.push(name);
        folderSet.add(encodeFolderPathKey(stack));
        const visMatch = attrs.match(
          /(?:DATA-VISIBILITY|VISIBILITY)\s*=\s*"([^"]*)"/i,
        );
        const vis = asFolderVisibility(visMatch?.[1]);
        visStack.push(vis);
        const sortMatch = attrs.match(
          /(?:DATA-SORT-ORDER|SORT_ORDER)\s*=\s*"([^"]*)"/i,
        );
        folder_meta.set(encodeFolderPathKey(stack), {
          visibility: vis,
          sort_order: asOptionalInt(sortMatch?.[1]),
          name,
        });
      }
      continue;
    }
    if (/<\/DL>/i.test(line)) {
      stack.pop();
      visStack.pop();
      continue;
    }
    const aMatch = line.match(
      /<A\s+([^>]*)HREF="([^"]*)"([^>]*)>([^<]*)<\/A>/i,
    );
    if (aMatch) {
      const pre = aMatch[1] || "";
      const url = decodeEntities((aMatch[2] || "").trim());
      const post = aMatch[3] || "";
      const attrs = `${pre} ${post}`;
      const title = decodeEntities((aMatch[4] || "").trim()) || url;
      if (!url || url === "#") {
        errors.push(`html anchor missing href near "${title.slice(0, 40)}"`);
        continue;
      }
      const addMatch = attrs.match(/ADD_DATE="(\d+)"/i);
      const tagsMatch = attrs.match(/TAGS="([^"]*)"/i);
      const visMatch = attrs.match(
        /(?:DATA-VISIBILITY|VISIBILITY)\s*=\s*"([^"]*)"/i,
      );
      const favMatch = attrs.match(
        /(?:DATA-FAVORITE|FAVORITE)\s*=\s*"([^"]*)"/i,
      );
      const archMatch = attrs.match(
        /(?:DATA-ARCHIVED|ARCHIVED)\s*=\s*"([^"]*)"/i,
      );
      const sortMatch = attrs.match(
        /(?:DATA-SORT-ORDER|SORT_ORDER)\s*=\s*"([^"]*)"/i,
      );
      const path = [...stack];
      bookmarks.push({
        title,
        url,
        url_normalized: normalizeUrl(url),
        folder_path: path,
        tags: tagsMatch
          ? tagsMatch[1]!.split(",").map((t) => t.trim()).filter(Boolean)
          : [],
        visibility: visMatch
          ? asFolderVisibility(visMatch[1])
          : undefined,
        is_favorite: favMatch ? truthyFlag(favMatch[1]) : undefined,
        is_archived: archMatch ? truthyFlag(archMatch[1]) : undefined,
        sort_order: asOptionalInt(sortMatch?.[1]),
        add_date: addMatch ? Number(addMatch[1]) : undefined,
      });
      if (path.length) folderSet.add(encodeFolderPathKey(path));
    }
  }

  return {
    bookmarks,
    folders: [...folderSet].map(decodeFolderPathKey),
    folder_meta,
    folder_by_export_id: new Map(),
    tags: [],
    errors,
  };
}

/** Parse CSV with title,url required; optional description,folder,tags,visibility. */
export function parseCsv(text: string): ParseResult {
  const bookmarks: ParsedBookmark[] = [];
  const folderSet = new Set<string>();
  const errors: string[] = [];
  const folder_meta = new Map<string, FolderPathMeta>();
  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    return emptyResult(["empty csv"]);
  }

  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const titleI = idx("title");
  const urlI = idx("url");
  if (titleI < 0 || urlI < 0) {
    return emptyResult(["CSV must include title and url columns"]);
  }
  const descI = idx("description");
  const folderI = idx("folder") >= 0 ? idx("folder") : idx("category");
  // Lossless nested path as JSON array column (RQG-F003)
  const folderPathI = idx("folder_path");
  const tagsI = idx("tags");
  const visI = idx("visibility");
  const favI = idx("is_favorite");
  const archI = idx("is_archived");
  const sortI = idx("sort_order");
  const folderVisI = idx("folder_visibility");

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const title = (row[titleI] ?? "").trim();
    const url = (row[urlI] ?? "").trim();
    if (!url) {
      errors.push(`row ${i + 1}: missing url`);
      continue;
    }
    let folder_path: string[] = [];
    const folderPathRaw =
      folderPathI >= 0 ? (row[folderPathI] ?? "").trim() : "";
    if (folderPathRaw) {
      try {
        const parsed = JSON.parse(folderPathRaw) as unknown;
        if (Array.isArray(parsed)) {
          folder_path = parsed.map(String).filter(Boolean);
        } else {
          errors.push(`row ${i + 1}: folder_path must be a JSON array`);
          continue;
        }
      } catch {
        errors.push(`row ${i + 1}: invalid folder_path JSON`);
        continue;
      }
    } else {
      const folderRaw = folderI >= 0 ? (row[folderI] ?? "").trim() : "";
      // Prefer `>` nesting; also accept / and \ for foreign CSVs.
      folder_path = folderRaw
        ? folderRaw
            .split(/>|[/\\]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    }
    if (folder_path.length) {
      folderSet.add(encodeFolderPathKey(folder_path));
      const fVis =
        folderVisI >= 0 ? (row[folderVisI] ?? "").trim() : "";
      if (fVis === "private" || fVis === "unlisted" || fVis === "public") {
        // Apply leaf folder visibility; ancestors default private unless set earlier
        folder_meta.set(encodeFolderPathKey(folder_path), {
          visibility: fVis,
          name: folder_path[folder_path.length - 1],
        });
      }
    }
    const tags =
      tagsI >= 0
        ? (row[tagsI] ?? "")
            .split(/[,;|]/)
            .map((t) => t.trim())
            .filter(Boolean)
        : [];
    const vis = visI >= 0 ? (row[visI] ?? "").trim() : "";
    bookmarks.push({
      title: title || url,
      url,
      url_normalized: normalizeUrl(url),
      description: descI >= 0 ? row[descI] || undefined : undefined,
      folder_path,
      tags,
      visibility:
        vis === "private" || vis === "unlisted" || vis === "public"
          ? vis
          : undefined,
      is_favorite: favI >= 0 ? truthyFlag(row[favI]) : undefined,
      is_archived: archI >= 0 ? truthyFlag(row[archI]) : undefined,
      sort_order: sortI >= 0 ? asOptionalInt(row[sortI]) : undefined,
    });
  }

  // Any row-level errors mean the payload is not fully valid (RQG-F008)
  return {
    bookmarks,
    folders: [...folderSet].map(decodeFolderPathKey),
    folder_meta,
    folder_by_export_id: new Map(),
    tags: [],
    errors,
  };
}

/** Parse MarkHub / LiteMark JSON export with strict native version checks. */
export function parseJsonExport(text: string): ParseResult {
  const bookmarks: ParsedBookmark[] = [];
  const folderSet = new Set<string>();
  const errors: string[] = [];
  let folder_meta = new Map<string, FolderPathMeta>();
  let folder_by_export_id = new Map<string, FolderPathMeta>();
  const tags: ParsedTag[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return emptyResult(["invalid json"]);
  }

  const root =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;

  // Native MarkHub envelope: reject unknown format/version before mutation (RQG-F008)
  if (root && root.format != null) {
    const fmt = String(root.format);
    if (fmt !== NATIVE_JSON_FORMAT && fmt !== "litemark-json") {
      return emptyResult([`unsupported json format: ${fmt}`]);
    }
    if (fmt === NATIVE_JSON_FORMAT) {
      if (root.version == null) {
        return emptyResult(["native markhub-json requires version"]);
      }
      const ver = Number(root.version);
      if (!NATIVE_JSON_VERSIONS.has(ver)) {
        return emptyResult([`unsupported native json version: ${root.version}`]);
      }
    }
  }

  const list: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray(root?.bookmarks)
      ? (root!.bookmarks as unknown[])
      : [];

  // Resolve folder_id → path when export embeds folders[] without folder_path (native MarkHub).
  let idPaths = new Map<string, string[]>();
  if (root && Array.isArray(root.folders)) {
    const exportFolders = root.folders as ExportFolderRow[];
    // Validate folder rows
    for (let i = 0; i < exportFolders.length; i++) {
      const f = exportFolders[i];
      if (!f || typeof f !== "object") {
        errors.push(`folders[${i}]: invalid row`);
        continue;
      }
      if (!f.id) {
        errors.push(`folders[${i}]: missing id`);
      }
    }
    idPaths = folderPathsFromExport(exportFolders);
    folder_meta = folderPathMetaFromExport(exportFolders);
    folder_by_export_id = folderIdentityMetaFromExport(exportFolders);
    for (const key of folder_meta.keys()) {
      folderSet.add(key);
    }
  }

  if (root && Array.isArray(root.tags)) {
    for (const raw of root.tags as unknown[]) {
      if (!raw || typeof raw !== "object") {
        errors.push("tags[] contains invalid row");
        continue;
      }
      const t = raw as Record<string, unknown>;
      const name = String(t.name ?? "").trim();
      if (!name) {
        errors.push("tags[] row missing name");
        continue;
      }
      tags.push({
        name,
        color: t.color != null ? String(t.color) : null,
        export_id: t.id != null ? String(t.id) : undefined,
      });
    }
  }

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== "object") {
      errors.push(`bookmarks[${i}]: invalid row`);
      continue;
    }
    const o = item as Record<string, unknown>;
    const url = String(o.url ?? "").trim();
    if (!url) {
      errors.push(`bookmarks[${i}]: missing url`);
      continue;
    }
    const title = String(o.title ?? url);
    let folder_path: string[] = [];
    let export_folder_id: string | undefined;
    if (Array.isArray(o.folder_path)) {
      // Prefer structured segments — lossless for names containing `/`.
      folder_path = o.folder_path.map(String);
    } else if (typeof o.folder_path === "string") {
      // Legacy string form is slash-split (lossy); native export uses arrays.
      folder_path = o.folder_path.split("/").filter(Boolean);
    } else if (typeof o.category === "string" && o.category) {
      folder_path = [o.category];
    } else if (typeof o.folder === "string" && o.folder) {
      folder_path = o.folder.split("/").filter(Boolean);
    } else if (o.folder_id != null && idPaths.has(String(o.folder_id))) {
      folder_path = idPaths.get(String(o.folder_id)) || [];
      export_folder_id = String(o.folder_id);
    }
    if (o.folder_id != null && !export_folder_id) {
      export_folder_id = String(o.folder_id);
    }
    if (folder_path.length) folderSet.add(encodeFolderPathKey(folder_path));
    const tagNames = normalizeTagNames(o.tags);
    const tag_colors = normalizeTagColors(o.tags, o.tag_objects);
    let visibility: ParsedBookmark["visibility"];
    if (
      o.visibility === "private" ||
      o.visibility === "unlisted" ||
      o.visibility === "public"
    ) {
      visibility = o.visibility;
    } else if (typeof o.visible === "boolean") {
      visibility = o.visible ? "public" : "private";
    }
    const is_favorite = truthyFlag(o.is_favorite);
    const is_archived = truthyFlag(o.is_archived);
    bookmarks.push({
      title,
      url,
      url_normalized: normalizeUrl(url),
      description: o.description != null ? String(o.description) : undefined,
      folder_path,
      export_folder_id,
      tags: tagNames,
      tag_colors: Object.keys(tag_colors).length ? tag_colors : undefined,
      visibility,
      is_favorite: is_favorite || undefined,
      is_archived: is_archived || undefined,
      sort_order: asOptionalInt(o.sort_order),
    });
  }

  return {
    bookmarks,
    folders: [...folderSet].map(decodeFolderPathKey),
    folder_meta,
    folder_by_export_id,
    tags,
    errors,
  };
}

/**
 * Reject partial / invalid parse results before any DB mutation (RQG-F008).
 * Returns a single error message or null when the payload is safe to apply.
 */
export function importParseRejection(parsed: ParseResult): string | null {
  if (parsed.errors.length) {
    return parsed.errors.join("; ");
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c === "\r") {
      // skip
    } else {
      cell += c;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}
