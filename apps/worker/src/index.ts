/**
 * MarkHub Cloudflare Worker — D1-backed API aligned with /api/v1 contract (F-001).
 */

import {
  normalizeUrl,
  effectiveVisibility,
  asVisibility,
  validateS3Config,
  assertSafeUrl,
  parseCsv,
  parseNetscapeHtml,
  parseJsonExport,
  shouldRunBackup,
  encodeFolderPathKey,
  decodeFolderPathKey,
  validateImportOptions,
  importParseRejection,
  type FolderDeleteMode,
  type FolderPathMeta,
  type ParsedBookmark,
  type ParsedTag,
} from "@markhub/core";
import { encryptSecret, decryptSecret, requireStrongSecret } from "./crypto";
import { logError, logInfo, logWarn, metrics, snapshotMetrics } from "./log";
import {
  classifyS3Error,
  s3DeleteObject,
  s3ListObjects,
  s3PutObject,
  type S3Creds,
} from "./s3";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  JWT_SECRET?: string;
  MARKHUB_MASTER_KEY?: string;
  DEFAULT_ADMIN_USERNAME?: string;
  DEFAULT_ADMIN_PASSWORD?: string;
  /** Test-only local binding. Not configured in deployed wrangler environments. */
  RESTORE_TEST_FAIL_PHASE?: string;
}

const VERSION = "0.1.0";
const MAX_FOLDER_DEPTH = 32;
const FOLDER_DELETE_MODES = new Set<FolderDeleteMode>([
  "move_to_parent",
  "move_to_inbox",
  "cascade_soft_delete",
]);

const SHARE_MAX_ATTEMPTS = 10;
const SHARE_WINDOW_MS = 300_000;
const RESTORE_STAGE_CHUNK_BYTES = 1_500_000;
const PORTABLE_BACKUP_METADATA_FORMAT = "markhub-portable-metadata";

type PortableBackupMetadata = {
  format: typeof PORTABLE_BACKUP_METADATA_FORMAT;
  version: 1;
  folders: unknown[];
  tags: unknown[];
  bookmarks: unknown[];
  bookmark_folder_ids: string[];
};

/** Escape text/attribute content for HTML exports (R4-F005). */
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Prefer http(s) URLs in export hrefs; neutralize javascript: etc. */
function safeHref(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "#";
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") return escapeHtml(u.toString());
  } catch {
    /* fall through */
  }
  if (/^https?:\/\//i.test(s)) return escapeHtml(s);
  return "#";
}

function portableBackupMetadata(
  payload: { folders: unknown[]; tags: unknown[] },
  bookmarks: Array<Record<string, unknown>>,
): string {
  return b64url(
    new TextEncoder().encode(
      JSON.stringify({
        format: PORTABLE_BACKUP_METADATA_FORMAT,
        version: 1,
        folders: payload.folders,
        tags: payload.tags,
        bookmarks,
        bookmark_folder_ids: bookmarks.map((bookmark) => String(bookmark.folder_id || "")),
      } satisfies PortableBackupMetadata),
    ),
  );
}

function decodePortableBackupMetadata(encoded: string): PortableBackupMetadata | null {
  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const meta = raw as Record<string, unknown>;
    if (
      meta.format !== PORTABLE_BACKUP_METADATA_FORMAT ||
      meta.version !== 1 ||
      !Array.isArray(meta.folders) ||
      !Array.isArray(meta.tags) ||
      !Array.isArray(meta.bookmarks) ||
      !Array.isArray(meta.bookmark_folder_ids) ||
      !meta.bookmark_folder_ids.every((id) => typeof id === "string")
    ) {
      return null;
    }
    return meta as PortableBackupMetadata;
  } catch {
    return null;
  }
}

function normalizeShareExpiry(value: unknown): string | null | Response {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() !== value || !value) {
    return err("validation", "expires_at must be an ISO-8601 timestamp with timezone or null");
  }
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) {
    return err("validation", "expires_at must be an ISO-8601 timestamp with timezone or null");
  }
  const [, ys, mos, ds, hs, mis, ss, fraction = "", zone] = match;
  const [year, month, day, hour, minute, second] = [ys, mos, ds, hs, mis, ss].map(Number);
  const millis = Number(fraction.padEnd(3, "0"));
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  if (
    year < 1 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second ||
    calendar.getUTCMilliseconds() !== millis
  ) {
    return err("validation", "expires_at is not a valid calendar timestamp");
  }
  if (zone !== "Z") {
    const zoneMatch = zone.match(/^([+-])(\d{2}):(\d{2})$/)!;
    const zoneHour = Number(zoneMatch[2]);
    const zoneMinute = Number(zoneMatch[3]);
    if (zoneHour > 23 || zoneMinute > 59) {
      return err("validation", "expires_at has an invalid timezone offset");
    }
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return err("validation", "expires_at is not a valid ISO-8601 timestamp");
  }
  return new Date(timestamp).toISOString();
}

function shareIsExpired(expiresAt: unknown): boolean {
  if (expiresAt === null || expiresAt === undefined || expiresAt === "") return false;
  if (typeof expiresAt !== "string") return true;
  const parsed = normalizeShareExpiry(expiresAt);
  if (parsed instanceof Response || parsed === null) return true;
  return Date.parse(parsed) <= Date.now();
}

function requireJwt(env: Env): string {
  try {
    return requireStrongSecret("JWT_SECRET", env.JWT_SECRET, 16);
  } catch (e) {
    throw e;
  }
}

function requireMaster(env: Env): string {
  return requireStrongSecret("MARKHUB_MASTER_KEY", env.MARKHUB_MASTER_KEY, 24);
}


const json = (data: unknown, init: ResponseInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
};

const err = (code: string, message: string, status = 400) =>
  json({ error: { code, message } }, { status });

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

type UserRow = { id: string; username: string; must_change_password: number | boolean };

const FORCE_CHANGE_ALLOW = new Set([
  "POST /auth/login",
  "POST /auth/logout",
  "GET /auth/me",
  "PUT /auth/credentials",
  "GET /health",
  "GET /version",
]);

function allowedDuringForceChange(method: string, path: string): boolean {
  return FORCE_CHANGE_ALLOW.has(`${method.toUpperCase()} ${path}`);
}

async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    key,
    256,
  );
  const hash = new Uint8Array(bits);
  const comb = new Uint8Array(salt.length + hash.length);
  comb.set(salt);
  comb.set(hash, salt.length);
  return btoa(String.fromCharCode(...comb));
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const comb = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    const salt = comb.slice(0, 16);
    const hash = comb.slice(16);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
      key,
      256,
    );
    const check = new Uint8Array(bits);
    if (check.length !== hash.length) return false;
    let ok = 0;
    for (let i = 0; i < check.length; i++) ok |= check[i]! ^ hash[i]!;
    return ok === 0;
  } catch {
    return false;
  }
}

function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(
    new TextEncoder().encode(
      JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + 7 * 86400 }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  try {
    const [header, body, sig] = token.split(".");
    if (!header || !body || !sig) return null;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
      new TextEncoder().encode(`${header}.${body}`),
    );
    if (!ok) return null;
    const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** RQG-DATA-CONSTRAINTS-002: D1/SQLite FK checks are off unless enabled per connection. */
async function enableForeignKeys(env: Env): Promise<void> {
  try {
    await env.DB.prepare("PRAGMA foreign_keys = ON").run();
  } catch {
    /* D1 may ignore PRAGMA in some contexts; schema still declares FKs */
  }
}

async function ensureBootstrap(env: Env) {
  await enableForeignKeys(env);
  const row = await env.DB.prepare("SELECT id FROM users LIMIT 1").first();
  if (row) return;
  const id = uuid();
  const username = env.DEFAULT_ADMIN_USERNAME || "admin";
  const password = env.DEFAULT_ADMIN_PASSWORD;
  if (!password || password === "admin123") {
    throw new Error("DEFAULT_ADMIN_PASSWORD must be set to a non-default value");
  }
  const hash = await hashPassword(password);
  const t = now();
  await env.DB.prepare(
    "INSERT INTO users (id, username, password_hash, must_change_password, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(id, username, hash, t, t)
    .run();
  const inbox = uuid();
  await env.DB.prepare(
    "INSERT INTO folders (id, user_id, parent_id, name, sort_order, visibility, is_system, created_at, updated_at) VALUES (?, ?, NULL, 'Inbox', 0, 'private', 1, ?, ?)",
  )
    .bind(inbox, id, t, t)
    .run();
  await env.DB.prepare(
    "INSERT INTO settings (user_id, key, value, is_secret) VALUES (?, 'inbox_folder_id', ?, 0)",
  )
    .bind(id, inbox)
    .run();
}

async function authUser(
  req: Request,
  env: Env,
  method: string,
  path: string,
): Promise<{ id: string; username: string; must_change_password: boolean } | Response | null> {
  const h = req.headers.get("Authorization");
  if (!h?.startsWith("Bearer ")) return null;
  let jwtSecret: string;
  try {
    jwtSecret = requireJwt(env);
  } catch {
    return err("misconfigured", "JWT_SECRET missing or insecure", 500);
  }
  const payload = await verifyJwt(h.slice(7), jwtSecret);
  if (!payload?.user_id) return null;
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(String(payload.user_id))
    .first<any>();
  if (!row) return null;
  const must = !!row.must_change_password;
  if (must && !allowedDuringForceChange(method, path)) {
    return err("must_change_password", "Password change required before accessing this resource", 403);
  }
  return { id: row.id, username: row.username, must_change_password: must };
}

async function writeOp(
  env: Env,
  userId: string,
  entityType: string,
  entityId: string,
  action: string,
  snapshot: unknown = null,
) {
  await env.DB.prepare(
    "INSERT INTO op_logs (user_id, entity_type, entity_id, action, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(userId, entityType, entityId, action, snapshot ? JSON.stringify(snapshot) : null, now())
    .run();
}

async function getSetting(env: Env, userId: string, key: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE user_id = ? AND key = ?",
  )
    .bind(userId, key)
    .first<{ value: string }>();
  return row?.value ?? "";
}

async function setSetting(
  env: Env,
  userId: string,
  key: string,
  value: string,
  isSecret = false,
) {
  let stored = value;
  if (isSecret && value) {
    stored = await encryptSecret(value, requireMaster(env));
  }
  await env.DB.prepare(
    `INSERT INTO settings (user_id, key, value, is_secret) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret`,
  )
    .bind(userId, key, stored, isSecret ? 1 : 0)
    .run();
}

async function getSecretSetting(env: Env, userId: string, key: string): Promise<string> {
  const raw = await getSetting(env, userId, key);
  if (!raw) return "";
  try {
    return await decryptSecret(raw, requireMaster(env));
  } catch {
    return raw; // legacy plaintext
  }
}

async function syncFts(
  env: Env,
  b: { id: string; title: string; url: string; description?: string | null },
  tagNames: string[] = [],
) {
  try {
    await env.DB.prepare("DELETE FROM bookmarks_fts WHERE bookmark_id = ?").bind(b.id).run();
    await env.DB.prepare(
      "INSERT INTO bookmarks_fts (bookmark_id, title, url, description, tags) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(b.id, b.title || "", b.url || "", b.description || "", tagNames.join(" "))
      .run();
  } catch {
    /* FTS optional */
  }
}

/** Batch-load tags for many bookmarks (avoids N+1 on list/search). */
async function tagsForBookmarks(
  env: Env,
  bookmarkIds: string[],
): Promise<Map<string, { id: string; name: string; color: string | null }[]>> {
  const map = new Map<string, { id: string; name: string; color: string | null }[]>();
  if (!bookmarkIds.length) return map;
  // D1 bind limit — chunk
  const chunkSize = 80;
  for (let i = 0; i < bookmarkIds.length; i += chunkSize) {
    const chunk = bookmarkIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (
      await env.DB.prepare(
        `SELECT bt.bookmark_id as bookmark_id, t.id as id, t.name as name, t.color as color
         FROM bookmark_tags bt
         INNER JOIN tags t ON t.id = bt.tag_id
         WHERE bt.bookmark_id IN (${placeholders})
         ORDER BY t.name`,
      )
        .bind(...chunk)
        .all<any>()
    ).results;
    for (const r of rows) {
      const list = map.get(r.bookmark_id) || [];
      list.push({ id: r.id, name: r.name, color: r.color ?? null });
      map.set(r.bookmark_id, list);
    }
  }
  return map;
}

function serializeBookmarkRow(
  b: any,
  tags: { id: string; name: string; color: string | null }[] = [],
) {
  return {
    ...b,
    is_favorite: !!b.is_favorite,
    is_archived: !!b.is_archived,
    tags,
  };
}

/** Resolve/create nested folder path (["A","B"]) under user tree. */
async function ensureFolderPath(
  env: Env,
  userId: string,
  pathParts: string[],
  cache: Map<string, string>,
  pathMeta?: Map<string, FolderPathMeta>,
): Promise<string> {
  const inbox = await getSetting(env, userId, "inbox_folder_id");
  if (!pathParts.length) return inbox || "";
  let parentId: string | null = null;
  const keyParts: string[] = [];
  for (const raw of pathParts) {
    const name = String(raw || "").trim();
    if (!name) continue;
    keyParts.push(name);
    // Segment-array key — names may legally contain `/` (RQG-BACKUP-001).
    const keyAcc = encodeFolderPathKey(keyParts);
    const meta = pathMeta?.get(keyAcc);
    const vis = meta?.visibility ? asVisibility(meta.visibility) : "private";
    const sortOrder =
      meta?.sort_order !== undefined && meta.sort_order !== null
        ? Number(meta.sort_order)
        : 0;
    if (cache.has(keyAcc)) {
      parentId = cache.get(keyAcc)!;
      if (pathMeta?.has(keyAcc)) {
        const existing = await env.DB.prepare(
          "SELECT id, visibility, is_system, sort_order FROM folders WHERE id=? AND deleted_at IS NULL",
        )
          .bind(parentId)
          .first<{ id: string; visibility: string; is_system: number; sort_order: number }>();
        if (existing && !existing.is_system) {
          const needVis = existing.visibility !== vis;
          const needSort =
            meta?.sort_order !== undefined && existing.sort_order !== sortOrder;
          if (needVis || needSort) {
            const t = now();
            await env.DB.prepare(
              "UPDATE folders SET visibility=?, sort_order=?, updated_at=? WHERE id=?",
            )
              .bind(vis, sortOrder, t, existing.id)
              .run();
            await writeOp(env, userId, "folder", existing.id, "update", {
              id: existing.id,
              visibility: vis,
              sort_order: sortOrder,
            });
          }
        }
      }
      continue;
    }
    let row: {
      id: string;
      visibility?: string;
      is_system?: number;
      sort_order?: number;
    } | null = await env.DB.prepare(
      "SELECT id, visibility, is_system, sort_order FROM folders WHERE user_id=? AND deleted_at IS NULL AND name=? AND " +
        (parentId ? "parent_id=?" : "parent_id IS NULL"),
    )
      .bind(...(parentId ? [userId, name, parentId] : [userId, name]))
      .first<{ id: string; visibility: string; is_system: number; sort_order: number }>();
    if (!row) {
      const id = uuid();
      const t = now();
      await env.DB.prepare(
        "INSERT INTO folders (id, user_id, parent_id, name, sort_order, visibility, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
      )
        .bind(id, userId, parentId, name, sortOrder, vis, t, t)
        .run();
      await writeOp(env, userId, "folder", id, "create", {
        id,
        name,
        parent_id: parentId,
        visibility: vis,
        sort_order: sortOrder,
      });
      row = { id, visibility: vis, is_system: 0, sort_order: sortOrder };
    } else if (pathMeta?.has(keyAcc) && !row.is_system) {
      const needVis = row.visibility !== vis;
      const needSort =
        meta?.sort_order !== undefined && row.sort_order !== sortOrder;
      if (needVis || needSort) {
        const t = now();
        await env.DB.prepare(
          "UPDATE folders SET visibility=?, sort_order=?, updated_at=? WHERE id=?",
        )
          .bind(vis, sortOrder, t, row.id)
          .run();
        await writeOp(env, userId, "folder", row.id, "update", {
          id: row.id,
          visibility: vis,
          sort_order: sortOrder,
        });
      }
    }
    cache.set(keyAcc, row.id);
    parentId = row.id;
  }
  return parentId || inbox || "";
}

/**
 * Recreate folders by export id so same-parent same-name rows stay distinct (RQG-F003).
 * Returns map export_folder_id → new live folder id.
 */
async function ensureFoldersByIdentity(
  env: Env,
  userId: string,
  folderByExportId: Map<string, FolderPathMeta>,
): Promise<Map<string, string>> {
  const idMap = new Map<string, string>();
  if (!folderByExportId.size) return idMap;
  const remaining = new Map(folderByExportId);
  let progress = true;
  while (remaining.size && progress) {
    progress = false;
    for (const [exportId, meta] of [...remaining.entries()]) {
      const parentExport = meta.parent_export_id ?? null;
      let parentId: string | null = null;
      if (parentExport && folderByExportId.has(parentExport)) {
        if (!idMap.has(parentExport)) continue;
        parentId = idMap.get(parentExport)!;
      }
      const name = String(meta.name || "").trim() || "Folder";
      const vis = meta.visibility ? asVisibility(meta.visibility) : "private";
      const sortOrder =
        meta.sort_order !== undefined && meta.sort_order !== null
          ? Number(meta.sort_order)
          : 0;
      const id = uuid();
      const t = now();
      await env.DB.prepare(
        "INSERT INTO folders (id, user_id, parent_id, name, sort_order, visibility, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
      )
        .bind(id, userId, parentId, name, sortOrder, vis, t, t)
        .run();
      await writeOp(env, userId, "folder", id, "create", {
        id,
        name,
        parent_id: parentId,
        visibility: vis,
        sort_order: sortOrder,
        export_id: exportId,
      });
      idMap.set(exportId, id);
      remaining.delete(exportId);
      progress = true;
    }
  }
  for (const [exportId, meta] of remaining) {
    const name = String(meta.name || "").trim() || "Folder";
    const vis = meta.visibility ? asVisibility(meta.visibility) : "private";
    const sortOrder =
      meta.sort_order !== undefined && meta.sort_order !== null
        ? Number(meta.sort_order)
        : 0;
    const id = uuid();
    const t = now();
    await env.DB.prepare(
      "INSERT INTO folders (id, user_id, parent_id, name, sort_order, visibility, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
    )
      .bind(id, userId, null, name, sortOrder, vis, t, t)
      .run();
    await writeOp(env, userId, "folder", id, "create", {
      id,
      name,
      parent_id: null,
      visibility: vis,
      sort_order: sortOrder,
      export_id: exportId,
    });
    idMap.set(exportId, id);
  }
  return idMap;
}

/** Soft-delete GC: permanently remove rows soft-deleted > 30 days ago. */
async function runSoftDeleteGc(env: Env, userId?: string): Promise<{ bookmarks: number; folders: number }> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  let bmSql =
    "SELECT id FROM bookmarks WHERE deleted_at IS NOT NULL AND deleted_at < ?";
  const bmBinds: unknown[] = [cutoff];
  if (userId) {
    bmSql += " AND user_id = ?";
    bmBinds.push(userId);
  }
  const bms = (await env.DB.prepare(bmSql).bind(...bmBinds).all<{ id: string }>()).results;
  for (const b of bms) {
    await env.DB.prepare("DELETE FROM bookmark_tags WHERE bookmark_id = ?").bind(b.id).run();
    try {
      await env.DB.prepare("DELETE FROM bookmarks_fts WHERE bookmark_id = ?").bind(b.id).run();
    } catch {
      /* optional */
    }
    await env.DB.prepare("DELETE FROM annotations WHERE bookmark_id = ?").bind(b.id).run();
    await env.DB.prepare("DELETE FROM bookmarks WHERE id = ?").bind(b.id).run();
  }
  let fdSql =
    "SELECT id, parent_id FROM folders WHERE deleted_at IS NOT NULL AND deleted_at < ? AND is_system = 0";
  const fdBinds: unknown[] = [cutoff];
  if (userId) {
    fdSql += " AND user_id = ?";
    fdBinds.push(userId);
  }
  const fds = (
    await env.DB.prepare(fdSql)
      .bind(...fdBinds)
      .all<{ id: string; parent_id: string | null }>()
  ).results;
  const parentById = new Map(fds.map((f) => [f.id, f.parent_id]));
  const depth = (id: string): number => {
    const seen = new Set<string>();
    let cursor: string | null | undefined = id;
    let value = 0;
    while (cursor && parentById.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parentById.get(cursor);
      value++;
    }
    return value;
  };
  fds.sort((a, b) => depth(b.id) - depth(a.id));
  let deletedFolders = 0;
  for (const f of fds) {
    const result = await env.DB.prepare(
      `DELETE FROM folders
       WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM folders child WHERE child.parent_id = folders.id)`,
    )
      .bind(f.id)
      .run();
    deletedFolders += Number(result.meta.changes || 0);
  }
  return { bookmarks: bms.length, folders: deletedFolders };
}

/** ai_tasks is provisioned by D1 migration 0004_ai_tasks.sql (RQG-CF-MIGRATION-001). */
async function ensureAiTasksTable(_env: Env) {
  /* no runtime DDL — schema comes from migrations */
}

/** Debounced-ish post-write board incremental scans (F020). Runs inline on Worker. */
async function scheduleBoardScansAfterBookmarkWrite(env: Env, userId: string) {
  try {
    const boards = (
      await env.DB.prepare("SELECT id FROM boards WHERE user_id = ?").bind(userId).all<{ id: string }>()
    ).results;
    for (const b of boards) {
      try {
        await runBoardScan(env, userId, b.id, "incremental");
      } catch (e) {
        logWarn("board_scan_after_write_fail", {
          board_id: b.id,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    logWarn("board_scan_schedule_fail", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Transform provider OpenAI SSE into MarkHub {delta}/{done} events (F012). */
function transformProviderSseToMarkHub(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n");
          buffer = parts.pop() || "";
          for (const line of parts) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const raw = trimmed.slice(5).trim();
            if (!raw) continue;
            if (raw === "[DONE]") {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
              continue;
            }
            try {
              const evt = JSON.parse(raw) as {
                choices?: { delta?: { content?: string }; message?: { content?: string } }[];
                error?: { message?: string };
              };
              if (evt.error?.message) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ error: evt.error.message })}\n\n`),
                );
                continue;
              }
              const delta =
                evt.choices?.[0]?.delta?.content ||
                evt.choices?.[0]?.message?.content ||
                "";
              if (delta) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`),
                );
              }
            } catch {
              /* skip malformed provider chunk */
            }
          }
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg.slice(0, 300) })}\n\n`));
        controller.close();
      }
    },
  });
}

function validateFolderDeleteMode(mode: string): FolderDeleteMode | Response {
  if (!FOLDER_DELETE_MODES.has(mode as FolderDeleteMode)) {
    return err(
      "validation",
      "mode must be one of: move_to_parent, move_to_inbox, cascade_soft_delete",
    );
  }
  return mode as FolderDeleteMode;
}

async function touchReorderClock(
  env: Env,
  userId: string,
  scope: string,
  parentId: string,
) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO reorder_clocks (user_id, scope, parent_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, scope, parent_id) DO UPDATE SET updated_at = excluded.updated_at`,
  )
    .bind(userId, scope, parentId || "", t)
    .run();
}

async function tagsForBookmark(env: Env, bookmarkId: string): Promise<{ id: string; name: string; color: string | null }[]> {
  const rows = (
    await env.DB.prepare(
      `SELECT t.id, t.name, t.color FROM tags t
       INNER JOIN bookmark_tags bt ON bt.tag_id = t.id
       WHERE bt.bookmark_id = ? ORDER BY t.name`,
    )
      .bind(bookmarkId)
      .all<any>()
  ).results;
  return rows;
}

async function setBookmarkTags(
  env: Env,
  userId: string,
  bookmarkId: string,
  tagNames: string[],
  tagColors?: Record<string, string | null>,
): Promise<{ id: string; name: string; color: string | null }[]> {
  await env.DB.prepare("DELETE FROM bookmark_tags WHERE bookmark_id = ?").bind(bookmarkId).run();
  const out: { id: string; name: string; color: string | null }[] = [];
  const t = now();
  for (const raw of tagNames) {
    const name = String(raw || "").trim();
    if (!name) continue;
    const wantColor =
      tagColors && Object.prototype.hasOwnProperty.call(tagColors, name)
        ? tagColors[name]
        : undefined;
    let tag = await env.DB.prepare("SELECT * FROM tags WHERE user_id = ? AND name = ?")
      .bind(userId, name)
      .first<any>();
    if (!tag) {
      const id = uuid();
      const color = wantColor !== undefined ? wantColor : null;
      await env.DB.prepare(
        "INSERT INTO tags (id, user_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(id, userId, name, color, t, t)
        .run();
      tag = { id, name, color };
    } else if (wantColor !== undefined && tag.color !== wantColor) {
      await env.DB.prepare("UPDATE tags SET color=?, updated_at=? WHERE id=?")
        .bind(wantColor, t, tag.id)
        .run();
      tag = { ...tag, color: wantColor };
    }
    await env.DB.prepare(
      "INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)",
    )
      .bind(bookmarkId, tag.id)
      .run();
    out.push({ id: tag.id, name: tag.name, color: tag.color ?? null });
  }
  return out;
}

/** Durable share unlock throttle via D1 (R4-F012). */
function shareThrottleKeys(token: string, clientIp: string | null): string[] {
  return [`share_unlock:${token}|all`, `share_unlock:${token}|${clientIp || "unknown"}`];
}

async function checkShareRateLimit(
  env: Env,
  token: string,
  clientIp: string | null,
): Promise<Response | null> {
  const nowMs = Date.now();
  const windowStart = nowMs - SHARE_WINDOW_MS;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0
      )`,
    ).run();
    for (const key of shareThrottleKeys(token, clientIp)) {
      const row = await env.DB.prepare("SELECT window_start, count FROM rate_limits WHERE key = ?")
        .bind(key)
        .first<{ window_start: number; count: number }>();
      if (row && row.window_start >= windowStart && row.count >= SHARE_MAX_ATTEMPTS) {
        logWarn("share_unlock_throttled", { token_prefix: token.slice(0, 6), ip: clientIp || "-" });
        return err("rate_limited", "Too many unlock attempts; try again later", 429);
      }
    }
  } catch (e) {
    logWarn("share_rate_limit_check_failed", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

async function recordFailedShareAttempt(env: Env, token: string, clientIp: string | null) {
  const nowMs = Date.now();
  const windowStart = nowMs - SHARE_WINDOW_MS;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0
      )`,
    ).run();
    for (const key of shareThrottleKeys(token, clientIp)) {
      const row = await env.DB.prepare("SELECT window_start, count FROM rate_limits WHERE key = ?")
        .bind(key)
        .first<{ window_start: number; count: number }>();
      if (!row || row.window_start < windowStart) {
        await env.DB.prepare(
          `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1`,
        )
          .bind(key, nowMs)
          .run();
      } else {
        await env.DB.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?")
          .bind(key)
          .run();
      }
    }
  } catch (e) {
    logWarn("share_rate_limit_record_failed", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function assertFolderParentOk(
  env: Env,
  userId: string,
  parentId: string | null | undefined,
  selfId?: string,
): Promise<Response | null> {
  if (!parentId) return null;
  const parent = await env.DB.prepare(
    "SELECT id, parent_id FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
  )
    .bind(parentId, userId)
    .first<{ id: string; parent_id: string | null }>();
  if (!parent) return err("validation", "parent folder not found", 400);
  // Walk ancestors for depth + cycle
  let depth = 0;
  let cur: string | null = parentId;
  const seen = new Set<string>();
  while (cur) {
    if (selfId && cur === selfId) return err("cycle", "Folder parent cycle detected", 400);
    if (seen.has(cur)) return err("cycle", "Folder parent cycle detected", 400);
    seen.add(cur);
    depth++;
    if (depth > MAX_FOLDER_DEPTH) {
      return err("depth_exceeded", `Folder depth exceeds ${MAX_FOLDER_DEPTH}`, 400);
    }
    const parentRow: { parent_id: string | null } | null = await env.DB.prepare(
      "SELECT parent_id FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
      .bind(cur, userId)
      .first<{ parent_id: string | null }>();
    cur = parentRow?.parent_id ?? null;
  }
  return null;
}

/**
 * Validate that folder_id references a live administrator-owned folder.
 * Shared by REST, batch, import/AI, MCP, and reorder write paths (RQG-CF-DATA-001).
 */
async function assertLiveFolder(
  env: Env,
  userId: string,
  folderId: string | null | undefined,
): Promise<Response | null> {
  if (!folderId) return err("validation", "folder_id is required", 400);
  const row = await env.DB.prepare(
    "SELECT id FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
  )
    .bind(folderId, userId)
    .first<{ id: string }>();
  if (!row) return err("validation", "folder not found", 400);
  return null;
}

/** Throw-style folder check for MCP and other non-HTTP callers. */
async function requireLiveFolder(env: Env, userId: string, folderId: string | null | undefined): Promise<string> {
  if (!folderId) throw new Error("folder_id is required");
  const row = await env.DB.prepare(
    "SELECT id FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
  )
    .bind(folderId, userId)
    .first<{ id: string }>();
  if (!row) throw new Error("folder not found");
  return row.id;
}

/** Serialize annotation rows so D1 integers become JSON booleans (RQG-CONTRACT-001). */
function serializeAnnotationRow(a: any) {
  let secondary: unknown = a.secondary_group_ids;
  if (typeof secondary === "string") {
    try {
      secondary = JSON.parse(secondary);
    } catch {
      secondary = [];
    }
  }
  let fields: unknown = a.fields;
  if (typeof fields === "string") {
    try {
      fields = JSON.parse(fields);
    } catch {
      fields = {};
    }
  }
  return {
    ...a,
    present: !!a.present,
    secondary_group_ids: Array.isArray(secondary) ? secondary : [],
    fields: fields && typeof fields === "object" ? fields : {},
  };
}

/** Build folder_id → path segments for native MarkHub JSON export. */
function folderPathSegments(folders: any[]): Map<string, string[]> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const cache = new Map<string, string[]>();
  const pathOf = (folderId: string, seen = new Set<string>()): string[] => {
    if (cache.has(folderId)) return cache.get(folderId)!;
    if (seen.has(folderId)) return [];
    seen.add(folderId);
    const f = byId.get(folderId);
    if (!f || f.is_system) {
      cache.set(folderId, []);
      return [];
    }
    const parent = f.parent_id ? pathOf(f.parent_id, seen) : [];
    const parts = [...parent, f.name].filter(Boolean);
    cache.set(folderId, parts);
    return parts;
  };
  for (const f of folders) pathOf(f.id);
  return cache;
}

/** Manual redirect following with per-hop SSRF checks (R4-F011). */
async function safeFetch(
  rawUrl: string,
  init: RequestInit & { maxRedirects?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const maxRedirects = init.maxRedirects ?? 3;
  const timeoutMs = init.timeoutMs ?? 10_000;
  let current = rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const safe = assertSafeUrl(current);
    if (!safe.ok) {
      throw Object.assign(new Error(safe.reason), { code: "ssrf", status: 400 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(safe.url.toString(), {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "MarkHub-Worker/0.1",
          ...(init.headers || {}),
        },
      });
      clearTimeout(timer);
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("Location");
        if (!loc) return r;
        current = new URL(loc, safe.url).toString();
        continue;
      }
      return r;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }
  throw Object.assign(new Error("too_many_redirects"), { code: "ssrf", status: 400 });
}

/**
 * Resolve public share payload. Soft-deleted / foreign targets return null so
 * callers respond 404 (RQG-SHARE-001 — live owner-owned rows only).
 */
async function resolveSharePayload(
  env: Env,
  link: any,
): Promise<Record<string, unknown> | null> {
  const payload: Record<string, unknown> = {
    target_type: link.target_type,
    target_id: link.target_id,
  };
  if (link.target_type === "bookmark") {
    const b = await env.DB.prepare(
      "SELECT title, url, description FROM bookmarks WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
      .bind(link.target_id, link.user_id)
      .first<any>();
    if (!b) return null;
    payload.bookmark = { title: b.title, url: b.url, description: b.description };
  } else if (link.target_type === "folder") {
    const f = await env.DB.prepare(
      "SELECT id, name FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
      .bind(link.target_id, link.user_id)
      .first<any>();
    if (!f) return null;
    payload.folder = { name: f.name, id: f.id };
    const bms = (
      await env.DB.prepare(
        "SELECT title, url, description FROM bookmarks WHERE folder_id = ? AND user_id = ? AND deleted_at IS NULL",
      )
        .bind(f.id, link.user_id)
        .all<any>()
    ).results;
    payload.bookmarks = bms.map((b) => ({
      title: b.title,
      url: b.url,
      description: b.description,
    }));
  }
  return payload;
}

async function chatCompletion(
  env: Env,
  userId: string,
  messages: { role: string; content: string }[],
  opts: { temperature?: number; max_tokens?: number } = {},
): Promise<string> {
  const key = await getSecretSetting(env, userId, "ai_api_key");
  if (!key) throw new Error("AI API key not set");
  const base = (await getSetting(env, userId, "ai_base_url")) || "https://api.openai.com/v1";
  const model = (await getSetting(env, userId, "ai_model")) || "gpt-4o-mini";
  const r = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.max_tokens,
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`provider_error: ${r.status} ${text.slice(0, 200)}`);
  }
  const data = (await r.json()) as any;
  return (data.choices?.[0]?.message?.content || "").trim();
}

/** Shared lossless JSON export for manual + remote backups (RQG-BACKUP-001). */
async function exportJsonPayload(env: Env, userId: string) {
  const bookmarks = (
    await env.DB.prepare("SELECT * FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL")
      .bind(userId)
      .all<any>()
  ).results;
  const folders = (
    await env.DB.prepare("SELECT * FROM folders WHERE user_id = ? AND deleted_at IS NULL")
      .bind(userId)
      .all<any>()
  ).results;
  const tags = (
    await env.DB.prepare("SELECT * FROM tags WHERE user_id = ?").bind(userId).all()
  ).results;
  const tagMap = await tagsForBookmarks(
    env,
    bookmarks.map((b) => b.id),
  );
  const paths = folderPathSegments(folders);
  const enriched = bookmarks.map((b) => {
    const row = serializeBookmarkRow(b, tagMap.get(b.id) || []);
    return {
      ...row,
      folder_path: paths.get(b.folder_id) || [],
      // Dual form: string names for importers + objects for clients
      tags: (row.tags || []).map((t: any) => (typeof t === "string" ? t : t.name)),
      tag_objects: row.tags || [],
      is_favorite: !!row.is_favorite,
      is_archived: !!row.is_archived,
    };
  });
  return {
    format: "markhub-json",
    version: 1,
    exported_at: now(),
    folders: folders.map((f: any) => ({
      ...f,
      is_system: !!f.is_system,
    })),
    bookmarks: enriched,
    tags,
  };
}

/**
 * Prune remote backups beyond keep_backups. Surfaces partial failures instead of
 * silently swallowing them (RQG-BACKUP-RETENTION-001).
 */
async function pruneS3Backups(
  creds: S3Creds,
  prefix: string,
  keep: number,
): Promise<{ pruned: number; retention_ok: boolean; retention_error?: string }> {
  const listed = await s3ListObjects(creds, { prefix, maxKeys: 1000 });
  if (!listed.ok) {
    return {
      pruned: 0,
      retention_ok: false,
      retention_error: `list failed: ${listed.message}`,
    };
  }
  const sorted = [...listed.keys]
    .filter((o) => o.Key.includes("markhub-backup-") && o.Key.endsWith(".json"))
    .sort((a, b) =>
      String(b.LastModified || b.Key).localeCompare(String(a.LastModified || a.Key)),
    );
  let pruned = 0;
  const errors: string[] = [];
  for (const old of sorted.slice(Math.max(0, keep))) {
    try {
      await s3DeleteObject(creds, old.Key);
      pruned++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (errors.length) {
    return {
      pruned,
      retention_ok: false,
      retention_error: `delete failed (${errors.length}): ${errors[0]!.slice(0, 120)}`,
    };
  }
  return { pruned, retention_ok: true };
}

async function pruneWebdavBackups(
  base: string,
  pathPrefix: string,
  auth: string,
  keep: number,
): Promise<{ pruned: number; retention_ok: boolean; retention_error?: string }> {
  try {
    const listUrl = `${base}/${pathPrefix}/`;
    const r = await fetch(listUrl, {
      method: "PROPFIND",
      headers: {
        ...(auth ? { Authorization: auth } : {}),
        Depth: "1",
        "Content-Type": "application/xml",
      },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
    });
    if (!r.ok) {
      return {
        pruned: 0,
        retention_ok: false,
        retention_error: `PROPFIND HTTP ${r.status}`,
      };
    }
    const text = await r.text();
    const names = [...text.matchAll(/markhub-backup-[^<"'\s]+\.json/g)].map((m) => m[0]!);
    const unique = [...new Set(names)].sort().reverse();
    let pruned = 0;
    const errors: string[] = [];
    for (const name of unique.slice(Math.max(0, keep))) {
      try {
        const del = await fetch(`${base}/${pathPrefix}/${name}`, {
          method: "DELETE",
          headers: auth ? { Authorization: auth } : {},
        });
        if (!del.ok && del.status !== 404) {
          errors.push(`DELETE ${name}: HTTP ${del.status}`);
        } else {
          pruned++;
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (errors.length) {
      return {
        pruned,
        retention_ok: false,
        retention_error: errors[0]!.slice(0, 160),
      };
    }
    return { pruned, retention_ok: true };
  } catch (e) {
    return {
      pruned: 0,
      retention_ok: false,
      retention_error: e instanceof Error ? e.message.slice(0, 160) : "list error",
    };
  }
}

async function getS3Creds(env: Env, userId: string): Promise<{ cfg: any; creds: S3Creds } | null> {
  const raw = await getSetting(env, userId, "s3_config");
  let cfg: any = {};
  try {
    cfg = raw ? JSON.parse(raw) : {};
  } catch {
    cfg = {};
  }
  const secret = await getSecretSetting(env, userId, "s3_secret_access_key");
  if (!cfg.endpoint || !cfg.bucket) return null;
  return {
    cfg,
    creds: {
      endpoint: cfg.endpoint,
      region: cfg.region || "auto",
      bucket: cfg.bucket,
      accessKeyId: cfg.access_key_id || "",
      secretAccessKey: secret,
      forcePathStyle: cfg.force_path_style !== false,
    },
  };
}

async function runS3Backup(
  env: Env,
  userId: string,
): Promise<
  | { ok: true; key: string; retention_ok: boolean; retention_error?: string; pruned?: number }
  | { ok: false; code: string; message: string }
> {
  const packed = await getS3Creds(env, userId);
  if (!packed) return { ok: false, code: "s3_config", message: "S3 not configured" };
  const { cfg, creds } = packed;
  const prefix = String(cfg.key_prefix || "markhub-backup/").replace(/^\//, "");
  const p = prefix.endsWith("/") ? prefix : prefix + "/";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const key = `${p}markhub-backup-${stamp}.json`;
  const body = JSON.stringify(await exportJsonPayload(env, userId), null, 2);
  const put = await s3PutObject(creds, key, body);
  if (!put.ok) {
    return {
      ok: false,
      code: classifyS3Error(put.status, put.message),
      message: put.message,
    };
  }
  const keep = Number(cfg.keep_backups || 7);
  const retention = await pruneS3Backups(creds, p, keep);
  if (!retention.retention_ok) {
    logWarn("s3_retention_partial", {
      key,
      error: retention.retention_error,
      pruned: retention.pruned,
    });
  }
  cfg.last_backup_at = now();
  cfg.last_backup_key = key;
  if (!retention.retention_ok) {
    cfg.last_retention_error = retention.retention_error;
  } else {
    delete cfg.last_retention_error;
  }
  await setSetting(env, userId, "s3_config", JSON.stringify(cfg));
  return {
    ok: true,
    key,
    retention_ok: retention.retention_ok,
    retention_error: retention.retention_error,
    pruned: retention.pruned,
  };
}

async function runWebdavBackup(
  env: Env,
  userId: string,
): Promise<
  | { ok: true; path: string; retention_ok: boolean; retention_error?: string; pruned?: number }
  | { ok: false; code: string; message: string }
> {
  const raw = await getSetting(env, userId, "webdav_config");
  let cfg: any = {};
  try {
    cfg = raw ? JSON.parse(raw) : {};
  } catch {
    cfg = {};
  }
  if (!cfg.url) return { ok: false, code: "webdav_config", message: "WebDAV not configured" };
  const password = await getSecretSetting(env, userId, "webdav_password");
  const base = String(cfg.url).replace(/\/$/, "");
  const pathPrefix = String(cfg.path || "markhub-backup/").replace(/^\//, "").replace(/\/$/, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const remotePath = `${pathPrefix}/markhub-backup-${stamp}.json`;
  const body = JSON.stringify(await exportJsonPayload(env, userId), null, 2);
  const auth =
    cfg.username || password
      ? "Basic " + btoa(`${cfg.username || ""}:${password || ""}`)
      : "";
  try {
    const r = await fetch(`${base}/${remotePath}`, {
      method: "PUT",
      headers: {
        ...(auth ? { Authorization: auth } : {}),
        "Content-Type": "application/json",
      },
      body,
    });
    if (!r.ok) {
      return {
        ok: false,
        code: "webdav_error",
        message: `HTTP ${r.status} ${(await r.text()).slice(0, 150)}`,
      };
    }
    const keep = Number(cfg.keep_backups || 7);
    const retention = await pruneWebdavBackups(base, pathPrefix, auth, keep);
    if (!retention.retention_ok) {
      logWarn("webdav_retention_partial", {
        path: remotePath,
        error: retention.retention_error,
        pruned: retention.pruned,
      });
      cfg.last_retention_error = retention.retention_error;
    } else {
      delete cfg.last_retention_error;
    }
    cfg.last_backup_at = now();
    await setSetting(env, userId, "webdav_config", JSON.stringify(cfg));
    return {
      ok: true,
      path: remotePath,
      retention_ok: retention.retention_ok,
      retention_error: retention.retention_error,
      pruned: retention.pruned,
    };
  } catch (e) {
    return {
      ok: false,
      code: "webdav_network",
      message: e instanceof Error ? e.message.slice(0, 200) : "network error",
    };
  }
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function enforceMcpOrigin(req: Request, env: Env, userId: string): Promise<Response | null> {
  const origin = req.headers.get("Origin");
  if (!origin) return null;
  const allowedRaw = await getSetting(env, userId, "mcp_allowed_origins");
  if (!allowedRaw?.trim()) return null;
  const allowed = allowedRaw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (allowed.includes(origin) || allowed.includes("*")) return null;
  return err("forbidden_origin", `Origin not allowed: ${origin}`, 403);
}

async function authorizeMcpUserOrigin(
  req: Request,
  env: Env,
  user: { id: string; username: string },
): Promise<{ id: string; username: string } | Response> {
  return (await enforceMcpOrigin(req, env, user.id)) || user;
}

async function authMcpUser(
  req: Request,
  env: Env,
): Promise<{ id: string; username: string } | Response> {
  const h = req.headers.get("Authorization");
  if (!h?.startsWith("Bearer ")) return err("unauthorized", "Bearer required", 401);
  const token = h.slice(7).trim();
  // OAuth access token stored as setting oauth_token_<token> -> user_id
  const oauthUser = await env.DB.prepare(
    "SELECT user_id, value FROM settings WHERE key = ? LIMIT 1",
  )
    .bind(`oauth_access_token:${token}`)
    .first<{ user_id: string; value: string }>();
  if (oauthUser) {
    try {
      const meta = JSON.parse(oauthUser.value);
      if (meta.exp && meta.exp > Math.floor(Date.now() / 1000)) {
        const user = await env.DB.prepare("SELECT id, username FROM users WHERE id = ?")
          .bind(oauthUser.user_id)
          .first<{ id: string; username: string }>();
        if (user) return authorizeMcpUserOrigin(req, env, user);
      }
    } catch {
      /* fall through */
    }
  }
  const th = await sha256Hex(token);
  const users = (await env.DB.prepare("SELECT id, username FROM users").all<{ id: string; username: string }>())
    .results;
  for (const u of users) {
    const enabled = await getSetting(env, u.id, "mcp_enabled");
    if (enabled !== "true") continue;
    // Token hash may be Fernet-wrapped (is_secret) or plain hex
    const stored = await getSecretSetting(env, u.id, "mcp_token_hash");
    if (stored && stored === th) {
      return authorizeMcpUserOrigin(req, env, u);
    }
  }
  return err("unauthorized", "Invalid MCP token", 401);
}

function clientIp(req: Request): string | null {
  // Cloudflare supplies this header at the runtime boundary. Do not fall back
  // to a forwarding chain that the original caller can choose.
  return req.headers.get("CF-Connecting-IP") || null;
}


async function folderPathMap(
  env: Env,
  userId: string,
): Promise<Map<string, string>> {
  const folders = (
    await env.DB.prepare(
      "SELECT id, parent_id, name FROM folders WHERE user_id = ? AND deleted_at IS NULL",
    )
      .bind(userId)
      .all<{ id: string; parent_id: string | null; name: string }>()
  ).results;
  const byId = new Map(folders.map((f) => [f.id, f]));
  const cache = new Map<string, string>();
  function pathOf(id: string): string {
    if (cache.has(id)) return cache.get(id)!;
    const parts: string[] = [];
    let cur: string | null = id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const f = byId.get(cur);
      if (!f) break;
      parts.unshift(f.name);
      cur = f.parent_id;
    }
    const p = parts.join(" / ");
    cache.set(id, p);
    return p;
  }
  for (const f of folders) pathOf(f.id);
  return cache;
}

async function runBoardScan(
  env: Env,
  userId: string,
  boardId: string,
  mode: "full" | "incremental" = "full",
): Promise<{ mode: string; created: number; updated: number; missing: number; cursor: number }> {
  const board = await env.DB.prepare("SELECT * FROM boards WHERE id = ? AND user_id = ?")
    .bind(boardId, userId)
    .first<any>();
  if (!board) throw new Error("Board not found");
  let sourceIds: string[] = [];
  try {
    sourceIds = JSON.parse(board.source_folder_ids || "[]");
  } catch {
    sourceIds = [];
  }
  const folders = (
    await env.DB.prepare("SELECT * FROM folders WHERE user_id = ? AND deleted_at IS NULL")
      .bind(userId)
      .all<any>()
  ).results;
  const children = new Map<string | null, string[]>();
  for (const f of folders) {
    const list = children.get(f.parent_id) || [];
    list.push(f.id);
    children.set(f.parent_id, list);
  }
  const subtree = new Set<string>();
  if (sourceIds.length) {
    const stack = [...sourceIds];
    while (stack.length) {
      const i = stack.pop()!;
      if (subtree.has(i)) continue;
      subtree.add(i);
      stack.push(...(children.get(i) || []));
    }
  } else {
    for (const f of folders) subtree.add(f.id);
  }

  const paths = await folderPathMap(env, userId);
  const t = now();
  let created = 0;
  let updated = 0;
  let missing = 0;
  const watermark = Number(board.last_incremental_cursor || 0);

  // Incremental: process only relevant ops after watermark; fall back to full when needed (R4-F007)
  if (mode === "incremental" && watermark > 0) {
    const ops = (
      await env.DB.prepare(
        `SELECT * FROM op_logs WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT 5000`,
      )
        .bind(userId, watermark)
        .all<any>()
    ).results;
    const affectedBm = new Set<string>();
    const deletedBm = new Set<string>();
    let forceFull = false;
    for (const op of ops) {
      if (op.entity_type === "bookmark") {
        if (op.action === "soft_delete" || op.action === "delete") {
          deletedBm.add(op.entity_id);
          affectedBm.delete(op.entity_id);
        } else {
          affectedBm.add(op.entity_id);
        }
      } else if (op.entity_type === "folder" || op.entity_type === "reorder") {
        // Folder moves/reorders can change membership paths → full re-eval is safer
        forceFull = true;
        break;
      }
    }
    if (!forceFull) {
      for (const bid of affectedBm) {
        const b = await env.DB.prepare(
          "SELECT * FROM bookmarks WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        )
          .bind(bid, userId)
          .first<any>();
        if (!b || !subtree.has(b.folder_id)) {
          // moved out of board sources → mark missing if annotated
          const ann = await env.DB.prepare(
            "SELECT * FROM annotations WHERE board_id = ? AND bookmark_id = ?",
          )
            .bind(boardId, bid)
            .first<any>();
          if (ann?.present) {
            await env.DB.prepare(
              "UPDATE annotations SET present=0, missing_since=?, annotation_updated_at=?, source_folder_path=? WHERE id=?",
            )
              .bind(t, t, paths.get(ann.source_folder_id) || null, ann.id)
              .run();
            await writeOp(env, userId, "annotation", ann.id, "update", {
              present: 0,
              from: "board_scan_incremental",
            });
            missing++;
          }
          continue;
        }
        const path = paths.get(b.folder_id) || "";
        const ann = await env.DB.prepare(
          "SELECT * FROM annotations WHERE board_id = ? AND bookmark_id = ?",
        )
          .bind(boardId, b.id)
          .first<any>();
        if (ann) {
          await env.DB.prepare(
            "UPDATE annotations SET present=1, last_seen_at=?, missing_since=NULL, source_folder_id=?, source_folder_path=?, annotation_updated_at=? WHERE id=?",
          )
            .bind(t, b.folder_id, path, t, ann.id)
            .run();
          await writeOp(env, userId, "annotation", ann.id, "update", {
            present: 1,
            from: "board_scan_incremental",
          });
          updated++;
        } else {
          const aid = uuid();
          await env.DB.prepare(
            `INSERT INTO annotations (id, board_id, bookmark_id, status, risk, price_tag, secondary_group_ids, source_folder_id, source_folder_path, present, first_seen_at, last_seen_at, annotation_updated_at, fields)
             VALUES (?, ?, ?, 'pending', '', '', '[]', ?, ?, 1, ?, ?, ?, '{}')`,
          )
            .bind(aid, boardId, b.id, b.folder_id, path, t, t, t)
            .run();
          await writeOp(env, userId, "annotation", aid, "create", {
            bookmark_id: b.id,
            from: "board_scan_incremental",
          });
          created++;
        }
      }
      for (const bid of deletedBm) {
        const ann = await env.DB.prepare(
          "SELECT * FROM annotations WHERE board_id = ? AND bookmark_id = ?",
        )
          .bind(boardId, bid)
          .first<any>();
        if (ann?.present) {
          await env.DB.prepare(
            "UPDATE annotations SET present=0, missing_since=?, annotation_updated_at=? WHERE id=?",
          )
            .bind(t, t, ann.id)
            .run();
          await writeOp(env, userId, "annotation", ann.id, "update", {
            present: 0,
            from: "board_scan_incremental_delete",
          });
          missing++;
        }
      }
      const maxOp =
        (
          await env.DB.prepare("SELECT MAX(id) as m FROM op_logs WHERE user_id = ?")
            .bind(userId)
            .first<{ m: number | null }>()
        )?.m || watermark;
      await env.DB.prepare(
        "UPDATE boards SET last_incremental_cursor=?, updated_at=? WHERE id=?",
      )
        .bind(maxOp, t, boardId)
        .run();
      return { mode: "incremental", created, updated, missing, cursor: maxOp };
    }
    // fall through to full
    mode = "full";
  }

  const bms = (
    await env.DB.prepare("SELECT * FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL")
      .bind(userId)
      .all<any>()
  ).results.filter((b) => subtree.has(b.folder_id));
  const existing = (
    await env.DB.prepare("SELECT * FROM annotations WHERE board_id = ?").bind(boardId).all<any>()
  ).results;
  const byBm = new Map(existing.map((a) => [a.bookmark_id, a]));
  const seen = new Set<string>();
  for (const b of bms) {
    const path = paths.get(b.folder_id) || "";
    const ann = byBm.get(b.id);
    if (ann) {
      await env.DB.prepare(
        "UPDATE annotations SET present=1, last_seen_at=?, missing_since=NULL, source_folder_id=?, source_folder_path=?, annotation_updated_at=? WHERE id=?",
      )
        .bind(t, b.folder_id, path, t, ann.id)
        .run();
      await writeOp(env, userId, "annotation", ann.id, "update", {
        present: 1,
        from: "board_scan",
      });
      updated++;
      seen.add(ann.id);
    } else {
      const aid = uuid();
      await env.DB.prepare(
        `INSERT INTO annotations (id, board_id, bookmark_id, status, risk, price_tag, secondary_group_ids, source_folder_id, source_folder_path, present, first_seen_at, last_seen_at, annotation_updated_at, fields)
         VALUES (?, ?, ?, 'pending', '', '', '[]', ?, ?, 1, ?, ?, ?, '{}')`,
      )
        .bind(aid, boardId, b.id, b.folder_id, path, t, t, t)
        .run();
      await writeOp(env, userId, "annotation", aid, "create", {
        bookmark_id: b.id,
        from: "board_scan",
      });
      created++;
      seen.add(aid);
    }
  }
  for (const a of existing) {
    if (!seen.has(a.id) && a.present) {
      await env.DB.prepare(
        "UPDATE annotations SET present=0, missing_since=?, annotation_updated_at=? WHERE id=?",
      )
        .bind(t, t, a.id)
        .run();
      await writeOp(env, userId, "annotation", a.id, "update", {
        present: 0,
        from: "board_scan",
      });
      missing++;
    }
  }
  const maxOp =
    (
      await env.DB.prepare("SELECT MAX(id) as m FROM op_logs WHERE user_id = ?")
        .bind(userId)
        .first<{ m: number | null }>()
    )?.m || 0;
  if (mode === "full") {
    await env.DB.prepare(
      "UPDATE boards SET last_full_scan_at=?, last_incremental_cursor=?, updated_at=? WHERE id=?",
    )
      .bind(t, maxOp, t, boardId)
      .run();
  } else {
    await env.DB.prepare(
      "UPDATE boards SET last_incremental_cursor=?, updated_at=? WHERE id=?",
    )
      .bind(maxOp, t, boardId)
      .run();
  }
  return { mode, created, updated, missing, cursor: maxOp };
}


const MCP_TOOL_NAMES = [
  "list_markhub_bookmarks",
  "get_markhub_bookmark",
  "add_markhub_bookmark",
  "update_markhub_bookmark",
  "delete_markhub_bookmark",
  "list_markhub_folders",
  "add_markhub_folder",
  "rename_markhub_folder",
  "delete_markhub_folder",
  "list_markhub_tags",
  "add_markhub_tag",
  "rename_markhub_tag",
  "reorder_markhub_bookmarks",
  "reorder_markhub_folders",
  "list_markhub_boards",
  "scan_board",
] as const;

async function dispatchMcpTool(
  env: Env,
  mcpUser: { id: string; username: string },
  name: string,
  a: any,
): Promise<unknown> {
  a = a || {};
  if (name === "list_markhub_bookmarks") {
    const limit = Math.min(Number(a.limit || 100), 500);
    let sql =
      "SELECT id, title, url, folder_id, visibility, description FROM bookmarks WHERE user_id=? AND deleted_at IS NULL";
    const binds: unknown[] = [mcpUser.id];
    if (a.folder_id) {
      sql += " AND folder_id=?";
      binds.push(a.folder_id);
    }
    if (a.query) {
      sql += " AND (title LIKE ? OR url LIKE ?)";
      const like = `%${a.query}%`;
      binds.push(like, like);
    }
    sql += ` ORDER BY sort_order LIMIT ${limit}`;
    const rows = (await env.DB.prepare(sql).bind(...binds).all()).results;
    return { items: rows, total: rows.length };
  }
  if (name === "get_markhub_bookmark") {
    const b = await env.DB.prepare(
      "SELECT * FROM bookmarks WHERE id=? AND user_id=? AND deleted_at IS NULL",
    )
      .bind(a.id, mcpUser.id)
      .first<any>();
    if (!b) throw new Error("Bookmark not found");
    const tags = await tagsForBookmark(env, b.id);
    return { ...b, is_favorite: !!b.is_favorite, is_archived: !!b.is_archived, tags };
  }
  if (name === "add_markhub_bookmark") {
    if (!a.url) throw new Error("url required");
    const id = uuid();
    const t = now();
    const inbox = await getSetting(env, mcpUser.id, "inbox_folder_id");
    const folderId = await requireLiveFolder(env, mcpUser.id, a.folder_id || inbox);
    const norm = normalizeUrl(a.url);
    await env.DB.prepare(
      `INSERT INTO bookmarks (id, user_id, folder_id, title, url, url_normalized, description, visibility, is_favorite, is_archived, sort_order, link_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'private', 0, 0, 0, 'unknown', ?, ?)`,
    )
      .bind(id, mcpUser.id, folderId, a.title || a.url, a.url, norm, a.description || null, t, t)
      .run();
    await writeOp(env, mcpUser.id, "bookmark", id, "create", { id, url: a.url });
    return { id, title: a.title || a.url, url: a.url, folder_id: folderId };
  }
  if (name === "update_markhub_bookmark") {
    const patch = a.patch || a;
    const b = await env.DB.prepare(
      "SELECT * FROM bookmarks WHERE id=? AND user_id=? AND deleted_at IS NULL",
    )
      .bind(a.id, mcpUser.id)
      .first<any>();
    if (!b) throw new Error("Bookmark not found");
    const title = patch.title ?? b.title;
    const bmUrl = patch.url ?? b.url;
    const description = patch.description !== undefined ? patch.description : b.description;
    const folder_id =
      patch.folder_id !== undefined
        ? await requireLiveFolder(env, mcpUser.id, patch.folder_id)
        : b.folder_id;
    const visibility = patch.visibility ? asVisibility(patch.visibility) : b.visibility;
    const norm = patch.url ? normalizeUrl(patch.url) : b.url_normalized;
    const t = now();
    await env.DB.prepare(
      `UPDATE bookmarks SET title=?, url=?, url_normalized=?, description=?, folder_id=?, visibility=?, updated_at=? WHERE id=?`,
    )
      .bind(title, bmUrl, norm, description, folder_id, visibility, t, a.id)
      .run();
    await writeOp(env, mcpUser.id, "bookmark", a.id, "update", { id: a.id });
    return { id: a.id, title, url: bmUrl, folder_id, visibility };
  }
  if (name === "delete_markhub_bookmark") {
    const t = now();
    await env.DB.prepare(
      "UPDATE bookmarks SET deleted_at=?, updated_at=? WHERE id=? AND user_id=?",
    )
      .bind(t, t, a.id, mcpUser.id)
      .run();
    await writeOp(env, mcpUser.id, "bookmark", a.id, "soft_delete", { id: a.id });
    return { ok: true, id: a.id };
  }
  if (name === "list_markhub_folders") {
    const rows = (
      await env.DB.prepare(
        "SELECT * FROM folders WHERE user_id=? AND deleted_at IS NULL ORDER BY sort_order",
      )
        .bind(mcpUser.id)
        .all()
    ).results;
    return { items: rows };
  }
  if (name === "add_markhub_folder") {
    const parentErr = await assertFolderParentOk(env, mcpUser.id, a.parent_id || null);
    if (parentErr) throw new Error("Invalid parent folder");
    const id = uuid();
    const t = now();
    const vis = asVisibility(a.visibility);
    await env.DB.prepare(
      "INSERT INTO folders (id, user_id, parent_id, name, sort_order, visibility, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)",
    )
      .bind(id, mcpUser.id, a.parent_id || null, a.name || "Folder", vis, t, t)
      .run();
    await writeOp(env, mcpUser.id, "folder", id, "create", { id, name: a.name });
    return { id, name: a.name || "Folder", parent_id: a.parent_id || null, visibility: vis };
  }
  if (name === "rename_markhub_folder") {
    const f = await env.DB.prepare(
      "SELECT * FROM folders WHERE id=? AND user_id=? AND deleted_at IS NULL",
    )
      .bind(a.id, mcpUser.id)
      .first<any>();
    if (!f) throw new Error("Folder not found");
    if (f.is_system) throw new Error("Cannot rename system folder");
    await env.DB.prepare(
      "UPDATE folders SET name=?, updated_at=? WHERE id=? AND user_id=?",
    )
      .bind(a.name, now(), a.id, mcpUser.id)
      .run();
    await writeOp(env, mcpUser.id, "folder", a.id, "update", { id: a.id, name: a.name });
    return { id: a.id, name: a.name };
  }
  if (name === "delete_markhub_folder") {
    const modeOrErr = validateFolderDeleteMode(a.mode || "move_to_parent");
    if (modeOrErr instanceof Response) throw new Error("invalid mode");
    const f = await env.DB.prepare(
      "SELECT * FROM folders WHERE id=? AND user_id=? AND deleted_at IS NULL",
    )
      .bind(a.id, mcpUser.id)
      .first<any>();
    if (!f) throw new Error("Folder not found");
    if (f.is_system) throw new Error("Cannot delete system folder");
    const mode = modeOrErr;
    const t = now();
    const inbox = await getSetting(env, mcpUser.id, "inbox_folder_id");
    const targetParent = mode === "move_to_inbox" ? inbox : f.parent_id || inbox;
    if (mode === "cascade_soft_delete") {
      await env.DB.prepare(
        "UPDATE bookmarks SET deleted_at=?, updated_at=? WHERE folder_id=? AND user_id=? AND deleted_at IS NULL",
      )
        .bind(t, t, a.id, mcpUser.id)
        .run();
    } else {
      await env.DB.prepare(
        "UPDATE bookmarks SET folder_id=?, updated_at=? WHERE folder_id=? AND user_id=? AND deleted_at IS NULL",
      )
        .bind(targetParent, t, a.id, mcpUser.id)
        .run();
      await env.DB.prepare(
        "UPDATE folders SET parent_id=?, updated_at=? WHERE parent_id=? AND user_id=? AND deleted_at IS NULL",
      )
        .bind(targetParent, t, a.id, mcpUser.id)
        .run();
    }
    await env.DB.prepare("UPDATE folders SET deleted_at=?, updated_at=? WHERE id=?")
      .bind(t, t, a.id)
      .run();
    await writeOp(env, mcpUser.id, "folder", a.id, "soft_delete", { id: a.id, mode });
    return { ok: true, id: a.id, mode };
  }
  if (name === "list_markhub_tags") {
    const rows = (
      await env.DB.prepare("SELECT * FROM tags WHERE user_id=? ORDER BY name")
        .bind(mcpUser.id)
        .all()
    ).results;
    return { items: rows };
  }
  if (name === "add_markhub_tag") {
    const id = uuid();
    const t = now();
    await env.DB.prepare(
      "INSERT INTO tags (id, user_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, mcpUser.id, a.name, a.color || null, t, t)
      .run();
    await writeOp(env, mcpUser.id, "tag", id, "create", { id, name: a.name });
    return { id, name: a.name, color: a.color || null };
  }
  if (name === "rename_markhub_tag") {
    await env.DB.prepare("UPDATE tags SET name=?, updated_at=? WHERE id=? AND user_id=?")
      .bind(a.name, now(), a.id, mcpUser.id)
      .run();
    await writeOp(env, mcpUser.id, "tag", a.id, "update", { id: a.id, name: a.name });
    return { id: a.id, name: a.name };
  }
  if (name === "reorder_markhub_bookmarks") {
    if (a.folder_id) {
      await requireLiveFolder(env, mcpUser.id, a.folder_id);
    }
    const t = now();
    let i = 0;
    for (const id of a.ordered_ids || []) {
      if (a.folder_id) {
        await env.DB.prepare(
          "UPDATE bookmarks SET sort_order=?, folder_id=?, updated_at=? WHERE id=? AND user_id=?",
        )
          .bind(i, a.folder_id, t, id, mcpUser.id)
          .run();
      } else {
        await env.DB.prepare(
          "UPDATE bookmarks SET sort_order=?, updated_at=? WHERE id=? AND user_id=?",
        )
          .bind(i, t, id, mcpUser.id)
          .run();
      }
      i++;
    }
    await touchReorderClock(env, mcpUser.id, "bookmark", a.folder_id || "");
    await writeOp(env, mcpUser.id, "reorder", a.folder_id || "root", "reorder", a);
    return { ok: true, ordered_ids: a.ordered_ids };
  }
  if (name === "reorder_markhub_folders") {
    // Route through the same system-folder / cycle / depth guards as REST (F004)
    if (a.parent_id) {
      const parentErr = await assertFolderParentOk(env, mcpUser.id, a.parent_id);
      if (parentErr) throw new Error("Invalid parent folder");
    }
    for (const fid of a.ordered_ids || []) {
      const f = await env.DB.prepare(
        "SELECT * FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
      )
        .bind(fid, mcpUser.id)
        .first<any>();
      if (!f) throw new Error("Folder not found");
      if (f.is_system && a.parent_id != null && a.parent_id !== f.parent_id) {
        throw new Error("Cannot reparent system folder via reorder");
      }
      if (!f.is_system && a.parent_id != null && a.parent_id !== f.parent_id) {
        const parentErr = await assertFolderParentOk(env, mcpUser.id, a.parent_id, fid);
        if (parentErr) throw new Error("Invalid folder parent (cycle or depth)");
      }
    }
    const t = now();
    let i = 0;
    for (const id of a.ordered_ids || []) {
      const f = await env.DB.prepare("SELECT * FROM folders WHERE id = ?").bind(id).first<any>();
      if (f?.is_system) {
        await env.DB.prepare(
          "UPDATE folders SET sort_order=?, updated_at=? WHERE id=? AND user_id=?",
        )
          .bind(i, t, id, mcpUser.id)
          .run();
      } else {
        await env.DB.prepare(
          "UPDATE folders SET sort_order=?, parent_id=COALESCE(?, parent_id), updated_at=? WHERE id=? AND user_id=?",
        )
          .bind(i, a.parent_id ?? null, t, id, mcpUser.id)
          .run();
      }
      i++;
    }
    await touchReorderClock(env, mcpUser.id, "folder", a.parent_id || "");
    await writeOp(env, mcpUser.id, "reorder", a.parent_id || "root", "reorder", a);
    return { ok: true, ordered_ids: a.ordered_ids };
  }
  if (name === "list_markhub_boards") {
    const rows = (
      await env.DB.prepare("SELECT * FROM boards WHERE user_id=? ORDER BY created_at DESC")
        .bind(mcpUser.id)
        .all<any>()
    ).results;
    return {
      items: rows.map((b) => ({
        ...b,
        source_folder_ids: JSON.parse(b.source_folder_ids || "[]"),
      })),
    };
  }
  if (name === "scan_board") {
    return await runBoardScan(
      env,
      mcpUser.id,
      a.id,
      a.mode === "incremental" ? "incremental" : "full",
    );
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handleMcpJsonRpc(
  env: Env,
  mcpUser: { id: string; username: string },
  body: any,
): Promise<Record<string, unknown>> {
  if (body.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "markhub-worker", version: VERSION },
      },
    };
  }
  if (body.method === "tools/list") {
    const tools = MCP_TOOL_NAMES.map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object" },
    }));
    return { jsonrpc: "2.0", id: body.id, result: { tools } };
  }
  if (body.method === "tools/call") {
    const name = body.params?.name || body.params?.tool || "";
    const args = body.params?.arguments || body.params?.input || {};
    try {
      const result = await dispatchMcpTool(env, mcpUser, name, args);
      return {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
        },
      };
    } catch (e) {
      return {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        },
      };
    }
  }
  return {
    jsonrpc: "2.0",
    id: body.id,
    error: { code: -32601, message: `Method not found: ${body.method}` },
  };
}

async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  await ensureBootstrap(env);
  const method = req.method;
  const url = new URL(req.url);

  if (path === "/health" && method === "GET") {
    let security_ok = true;
    try {
      requireJwt(env);
      requireMaster(env);
    } catch {
      security_ok = false;
    }
    return json({
      status: security_ok ? "ok" : "degraded",
      version: VERSION,
      service: "markhub-worker",
      dependencies: { database: "ok", master_key: security_ok ? "ok" : "missing" },
      security_ok,
      metrics: snapshotMetrics(),
    });
  }
  if (path === "/metrics" && method === "GET") {
    return json({ service: "markhub-worker", version: VERSION, ...snapshotMetrics() });
  }
  if (path === "/version" && method === "GET") {
    return json({ version: VERSION, name: "MarkHub" });
  }
  if (path === "/version/latest" && method === "GET") {
    return json({ latest: VERSION, current: VERSION, update_available: false });
  }

  if (path === "/auth/login" && method === "POST") {
    const body = (await req.json()) as { username?: string; password?: string };
    const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?")
      .bind(body.username || "")
      .first<any>();
    if (!user || !(await verifyPassword(body.password || "", user.password_hash))) {
      return err("invalid_credentials", "Invalid username or password", 401);
    }
    let jwtSecret: string;
    try {
      jwtSecret = requireJwt(env);
    } catch {
      return err("misconfigured", "JWT_SECRET missing or insecure", 500);
    }
    const token = await signJwt(
      { sub: user.username, user_id: user.id },
      jwtSecret,
    );
    return json({
      access_token: token,
      token_type: "bearer",
      must_change_password: !!user.must_change_password,
      user: {
        id: user.id,
        username: user.username,
        must_change_password: !!user.must_change_password,
      },
    });
  }

  // Public share resolution (no JWT) — must run before auth gate
  if (path.match(/^\/shares\/[^/]+\/unlock$/) && method === "POST") {
    const token = path.split("/")[2]!;
    const body = (await req.json()) as { password?: string };
    const ip = clientIp(req);
    const link = await env.DB.prepare("SELECT * FROM share_links WHERE token=?")
      .bind(token)
      .first<any>();
    if (!link) return err("not_found", "Share not found", 404);
    if (shareIsExpired(link.expires_at)) {
      return err("expired", "Share link expired", 410);
    }
    if (link.password_hash) {
      const limited = await checkShareRateLimit(env, token, ip);
      if (limited) return limited;
      if (!body.password || !(await verifyPassword(body.password, link.password_hash))) {
        await recordFailedShareAttempt(env, token, ip);
        logInfo("share_unlock_failed", { token_prefix: token.slice(0, 6), ip: ip || "-" });
        return err("password_required", "Password required or incorrect", 401);
      }
      logInfo("share_unlock_ok", { token_prefix: token.slice(0, 6), ip: ip || "-" });
    }
    const unlocked = await resolveSharePayload(env, link);
    if (!unlocked) return err("not_found", "Share target not found", 404);
    return json(unlocked);
  }
  if (path.match(/^\/shares\/[^/]+$/) && method === "GET") {
    const token = path.slice("/shares/".length);
    if (url.searchParams.has("password")) {
      return err("password_in_query", "Pass password via POST unlock body", 400);
    }
    const link = await env.DB.prepare("SELECT * FROM share_links WHERE token=?")
      .bind(token)
      .first<any>();
    if (!link) return err("not_found", "Share not found", 404);
    if (shareIsExpired(link.expires_at)) {
      return err("expired", "Share link expired", 410);
    }
    if (link.password_hash) return err("password_required", "Password required", 401);
    const resolved = await resolveSharePayload(env, link);
    if (!resolved) return err("not_found", "Share target not found", 404);
    return json(resolved);
  }

  // OAuth client credentials for MCP (public endpoint)
  if (path === "/oauth/token" && method === "POST") {
    let body: any = {};
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      body = await req.json();
    } else {
      const form = await req.formData();
      body = Object.fromEntries(form.entries());
    }
    if (body.grant_type !== "client_credentials") {
      return err("invalid_grant", "grant_type must be client_credentials", 400);
    }
    if (body.client_id !== "markhub-mcp") {
      return err("invalid_client", "client_id must be markhub-mcp", 401);
    }
    const secret = String(body.client_secret || "");
    const th = await sha256Hex(secret);
    const users = (
      await env.DB.prepare("SELECT id FROM users").all<{ id: string }>()
    ).results;
    let matched: string | null = null;
    for (const u of users) {
      const enabled = await getSetting(env, u.id, "mcp_enabled");
      if (enabled !== "true") continue;
      const stored = await getSecretSetting(env, u.id, "mcp_token_hash");
      if (stored && stored === th) {
        matched = u.id;
        break;
      }
    }
    if (!matched) return err("invalid_client", "Invalid client_secret", 401);
    const access = b64url(crypto.getRandomValues(new Uint8Array(24)));
    const expiresIn = 3600;
    await setSetting(
      env,
      matched,
      `oauth_access_token:${access}`,
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresIn, client_id: "markhub-mcp" }),
    );
    return json({
      access_token: access,
      token_type: "bearer",
      expires_in: expiresIn,
      scope: "mcp",
    });
  }

  if (path === "/nav/public" && method === "GET") {
    const user = await env.DB.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>();
    if (!user) return json({ tree: [] });
    const folders = (
      await env.DB.prepare("SELECT * FROM folders WHERE user_id = ? AND deleted_at IS NULL")
        .bind(user.id)
        .all<any>()
    ).results;
    const bookmarks = (
      await env.DB.prepare(
        "SELECT * FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL AND is_archived = 0",
      )
        .bind(user.id)
        .all<any>()
    ).results;
    const byId = new Map(folders.map((f) => [f.id, f]));
    const anc = (folderId: string | null): string[] => {
      const chain: string[] = [];
      let cur = folderId;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const f = byId.get(cur);
        if (!f) break;
        chain.push(asVisibility(f.visibility));
        cur = f.parent_id;
      }
      return chain;
    };
    const publicFolders = new Set(
      folders
        .filter((f) => effectiveVisibility(asVisibility(f.visibility), anc(f.parent_id)) === "public")
        .map((f) => f.id),
    );
    const children = new Map<string | null, any[]>();
    for (const f of folders) {
      if (!publicFolders.has(f.id)) continue;
      if (f.parent_id && !publicFolders.has(f.parent_id)) continue;
      const list = children.get(f.parent_id) || [];
      list.push({
        type: "folder",
        id: f.id,
        name: f.name,
        visibility: f.visibility,
        sort_order: f.sort_order,
        children: [],
      });
      children.set(f.parent_id, list);
    }
    const bmByFolder = new Map<string, any[]>();
    for (const b of bookmarks) {
      if (effectiveVisibility(asVisibility(b.visibility), anc(b.folder_id)) !== "public") continue;
      if (!publicFolders.has(b.folder_id)) continue;
      const list = bmByFolder.get(b.folder_id) || [];
      list.push({
        type: "bookmark",
        id: b.id,
        title: b.title,
        url: b.url,
        description: b.description,
        visibility: b.visibility,
        sort_order: b.sort_order,
      });
      bmByFolder.set(b.folder_id, list);
    }
    const attach = (nodes: any[]): any[] => {
      for (const n of nodes) {
        if (n.type === "folder") {
          const kids = attach(children.get(n.id) || []);
          const bms = bmByFolder.get(n.id) || [];
          n.children = [...kids, ...bms].sort(
            (a, b) =>
              a.sort_order - b.sort_order ||
              (a.name || a.title || "").localeCompare(b.name || b.title || ""),
          );
        }
      }
      return nodes.sort(
        (a, b) =>
          a.sort_order - b.sort_order ||
          (a.name || a.title || "").localeCompare(b.name || b.title || ""),
      );
    };
    return json({ tree: attach(children.get(null) || []) });
  }

  const authResult = await authUser(req, env, method, path);
  if (authResult instanceof Response) return authResult;
  // Narrow for nested closures (cleaner / quick-add) that capture user
  const user = authResult as {
    id: string;
    username: string;
    must_change_password: boolean;
  } | null;

  if (path === "/auth/me" && method === "GET") {
    if (!user) return err("unauthorized", "Missing token", 401);
    return json({
      id: user.id,
      username: user.username,
      must_change_password: user.must_change_password,
    });
  }

  if (path === "/auth/logout" && method === "POST") {
    if (!user) return err("unauthorized", "Missing token", 401);
    return json({ ok: true });
  }

  if (path === "/auth/credentials" && method === "PUT") {
    if (!user) return err("unauthorized", "Missing token", 401);
    const body = (await req.json()) as {
      current_password?: string;
      new_username?: string;
      new_password?: string;
    };
    const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first<any>();
    if (!row || !(await verifyPassword(body.current_password || "", row.password_hash))) {
      return err("invalid_credentials", "Current password incorrect", 401);
    }
    let username = row.username;
    let hash = row.password_hash;
    let must = row.must_change_password;
    if (body.new_username) username = body.new_username.trim();
    if (body.new_password) {
      if (body.new_password.length < 6) return err("validation", "Password must be at least 6 characters");
      hash = await hashPassword(body.new_password);
      must = 0;
    }
    await env.DB.prepare(
      "UPDATE users SET username = ?, password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?",
    )
      .bind(username, hash, must, now(), user.id)
      .run();
    return json({ id: user.id, username, must_change_password: !!must });
  }

  // MCP uses its own bearer/OAuth auth (not admin JWT) — handled before JWT-gated routes
  if (path === "/mcp" && (method === "POST" || method === "GET")) {
    const mcpAuth = await authMcpUser(req, env);
    if (mcpAuth instanceof Response) return mcpAuth;
    const mcpUser: { id: string; username: string } = mcpAuth;
    metrics.mcp_calls++;
    if (method === "GET") {
      return json({
        name: "markhub",
        version: VERSION,
        protocolVersion: "2024-11-05",
        transport: "streamable-http",
        capabilities: { tools: {} },
      });
    }
    const body = (await req.json()) as any;
    try {
      const result = await handleMcpJsonRpc(env, mcpUser, body);
      return json(result);
    } catch (e) {
      return json({
        jsonrpc: "2.0",
        id: body?.id ?? null,
        error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  // All routes below require auth
  if (!user) return err("unauthorized", "Missing token", 401);
  // Narrow for nested closures (import helpers, etc.)
  const authed = user;

  // ── Tags ──
  if (path === "/tags" && method === "GET") {
    const rows = (
      await env.DB.prepare(
        "SELECT * FROM tags WHERE user_id = ? ORDER BY name",
      )
        .bind(user.id)
        .all<any>()
    ).results;
    return json({ items: rows });
  }
  if (path === "/tags" && method === "POST") {
    const body = (await req.json()) as any;
    const id = uuid();
    const t = now();
    await env.DB.prepare(
      "INSERT INTO tags (id, user_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, user.id, body.name, body.color || null, t, t)
      .run();
    await writeOp(env, user.id, "tag", id, "create", { id, name: body.name });
    return json({ id, user_id: user.id, name: body.name, color: body.color || null, created_at: t, updated_at: t });
  }

  // ── Folders ──
  if (path === "/folders" && method === "GET") {
    const rows = (
      await env.DB.prepare(
        "SELECT * FROM folders WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order, name",
      )
        .bind(user.id)
        .all<any>()
    ).results;
    return json({ items: rows.map((f) => ({ ...f, is_system: !!f.is_system })) });
  }

  if (path === "/folders" && method === "POST") {
    const body = (await req.json()) as any;
    if (!body.name || !String(body.name).trim()) return err("validation", "name is required");
    const parentId = body.parent_id || null;
    const parentErr = await assertFolderParentOk(env, user.id, parentId);
    if (parentErr) return parentErr;
    const id = uuid();
    const t = now();
    const vis = asVisibility(body.visibility);
    await env.DB.prepare(
      "INSERT INTO folders (id, user_id, parent_id, name, sort_order, visibility, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)",
    )
      .bind(id, user.id, parentId, body.name, vis, t, t)
      .run();
    await writeOp(env, user.id, "folder", id, "create", { id, name: body.name });
    return json({
      id,
      user_id: user.id,
      parent_id: parentId,
      name: body.name,
      sort_order: 0,
      visibility: vis,
      is_system: false,
      deleted_at: null,
      created_at: t,
      updated_at: t,
    });
  }

  if (path.startsWith("/folders/") && method === "PATCH") {
    const id = path.slice("/folders/".length);
    const body = (await req.json()) as any;
    const f = await env.DB.prepare(
      "SELECT * FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
      .bind(id, user.id)
      .first<any>();
    if (!f) return err("not_found", "Folder not found", 404);
    if (f.is_system && (body.parent_id !== undefined || body.visibility !== undefined)) {
      return err("system_folder", "Cannot change parent/visibility of system folder");
    }
    const name = body.name ?? f.name;
    const parent_id = body.parent_id !== undefined ? body.parent_id : f.parent_id;
    if (parent_id !== f.parent_id) {
      const parentErr = await assertFolderParentOk(env, user.id, parent_id, id);
      if (parentErr) return parentErr;
    }
    const visibility = body.visibility ? asVisibility(body.visibility) : f.visibility;
    await env.DB.prepare(
      "UPDATE folders SET name = ?, parent_id = ?, visibility = ?, updated_at = ? WHERE id = ?",
    )
      .bind(name, parent_id, visibility, now(), id)
      .run();
    await writeOp(env, user.id, "folder", id, "update", { id, name });
    return json({ ...f, name, parent_id, visibility, is_system: !!f.is_system });
  }

  if (path.startsWith("/folders/") && method === "DELETE" && !path.includes("reorder")) {
    const id = path.slice("/folders/".length).split("?")[0]!;
    const modeRaw = url.searchParams.get("mode") || "move_to_parent";
    const modeOrErr = validateFolderDeleteMode(modeRaw);
    if (modeOrErr instanceof Response) return modeOrErr;
    const mode = modeOrErr;
    const f = await env.DB.prepare(
      "SELECT * FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
      .bind(id, user.id)
      .first<any>();
    if (!f) return err("not_found", "Folder not found", 404);
    if (f.is_system) return err("system_folder", "Cannot delete system folder");
    const t = now();
    const inbox = await getSetting(env, user.id, "inbox_folder_id");
    const targetParent = mode === "move_to_inbox" ? inbox : f.parent_id || inbox;
    if (mode === "cascade_soft_delete") {
      const stack = [id];
      while (stack.length) {
        const fid = stack.pop()!;
        const kids = (
          await env.DB.prepare(
            "SELECT id FROM folders WHERE parent_id = ? AND user_id = ? AND deleted_at IS NULL",
          )
            .bind(fid, user.id)
            .all<{ id: string }>()
        ).results;
        for (const k of kids) stack.push(k.id);
        await env.DB.prepare(
          "UPDATE bookmarks SET deleted_at = ?, updated_at = ? WHERE folder_id = ? AND user_id = ? AND deleted_at IS NULL",
        )
          .bind(t, t, fid, user.id)
          .run();
        if (fid !== id) {
          await env.DB.prepare(
            "UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ?",
          )
            .bind(t, t, fid)
            .run();
        }
      }
    } else {
      await env.DB.prepare(
        "UPDATE bookmarks SET folder_id = ?, updated_at = ? WHERE folder_id = ? AND user_id = ? AND deleted_at IS NULL",
      )
        .bind(targetParent, t, id, user.id)
        .run();
      await env.DB.prepare(
        "UPDATE folders SET parent_id = ?, updated_at = ? WHERE parent_id = ? AND user_id = ? AND deleted_at IS NULL",
      )
        .bind(targetParent, t, id, user.id)
        .run();
    }
    await env.DB.prepare("UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .bind(t, t, id)
      .run();
    await writeOp(env, user.id, "folder", id, "soft_delete", { id, mode });
    return json({ ok: true, id, mode });
  }

  if (path === "/folders/reorder" && method === "POST") {
    const body = (await req.json()) as { parent_id?: string | null; ordered_ids: string[] };
    if (body.parent_id) {
      const parentErr = await assertFolderParentOk(env, user.id, body.parent_id);
      if (parentErr) return parentErr;
    }
    for (const fid of body.ordered_ids || []) {
      const f = await env.DB.prepare(
        "SELECT * FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
      )
        .bind(fid, user.id)
        .first<any>();
      if (!f) return err("not_found", "Folder not found", 404);
      if (f.is_system && body.parent_id != null && body.parent_id !== f.parent_id) {
        return err("system_folder", "Cannot reparent system folder via reorder");
      }
      if (!f.is_system && body.parent_id != null && body.parent_id !== f.parent_id) {
        const parentErr = await assertFolderParentOk(env, user.id, body.parent_id, fid);
        if (parentErr) return parentErr;
      }
    }
    const t = now();
    let i = 0;
    for (const fid of body.ordered_ids || []) {
      const f = await env.DB.prepare("SELECT * FROM folders WHERE id = ?").bind(fid).first<any>();
      if (f?.is_system) {
        await env.DB.prepare("UPDATE folders SET sort_order = ?, updated_at = ? WHERE id = ?")
          .bind(i, t, fid)
          .run();
      } else {
        await env.DB.prepare(
          "UPDATE folders SET sort_order = ?, parent_id = ?, updated_at = ? WHERE id = ?",
        )
          .bind(i, body.parent_id ?? null, t, fid)
          .run();
      }
      i++;
    }
    await touchReorderClock(env, user.id, "folder", body.parent_id || "");
    await writeOp(env, user.id, "reorder", body.parent_id || "root", "reorder", body);
    return json({ ok: true, ordered_ids: body.ordered_ids });
  }

  // ── Bookmarks ──
  if (path === "/bookmarks" && method === "GET") {
    const folderId = url.searchParams.get("folder_id");
    const q = url.searchParams.get("q");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 500), 1), 1000);
    const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
    const term = (q || "").replace(/["']/g, " ").trim();

    // Prefer direct FTS join + page for large result sets (F017); no 5k ID cap
    if (term) {
      try {
        const match = term || '""';
        let ftsCountSql = `SELECT COUNT(*) as c FROM bookmarks_fts
          INNER JOIN bookmarks b ON b.id = bookmarks_fts.bookmark_id
          WHERE b.user_id = ? AND b.deleted_at IS NULL AND bookmarks_fts MATCH ?`;
        const countBinds: unknown[] = [user.id, match];
        let ftsSql = `SELECT b.* FROM bookmarks_fts
          INNER JOIN bookmarks b ON b.id = bookmarks_fts.bookmark_id
          WHERE b.user_id = ? AND b.deleted_at IS NULL AND bookmarks_fts MATCH ?`;
        const binds: unknown[] = [user.id, match];
        if (folderId) {
          ftsCountSql += " AND b.folder_id = ?";
          ftsSql += " AND b.folder_id = ?";
          countBinds.push(folderId);
          binds.push(folderId);
        }
        ftsSql += " ORDER BY b.sort_order, b.created_at LIMIT ? OFFSET ?";
        binds.push(limit, offset);
        const total =
          (
            await env.DB.prepare(ftsCountSql)
              .bind(...countBinds)
              .first<{ c: number }>()
          )?.c ?? 0;
        const rows = (await env.DB.prepare(ftsSql).bind(...binds).all<any>()).results;
        const tagMap = await tagsForBookmarks(
          env,
          rows.map((r) => r.id),
        );
        return json({
          items: rows.map((r) => serializeBookmarkRow(r, tagMap.get(r.id) || [])),
          total,
          limit,
          offset,
        });
      } catch {
        /* fall through to LIKE */
      }
    }

    let sql = "SELECT * FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL";
    let countSql = "SELECT COUNT(*) as c FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL";
    const binds: unknown[] = [user.id];
    const countBinds: unknown[] = [user.id];
    if (folderId) {
      sql += " AND folder_id = ?";
      countSql += " AND folder_id = ?";
      binds.push(folderId);
      countBinds.push(folderId);
    }
    if (term) {
      sql += " AND (title LIKE ? OR url LIKE ? OR description LIKE ?)";
      countSql += " AND (title LIKE ? OR url LIKE ? OR description LIKE ?)";
      const like = `%${term}%`;
      binds.push(like, like, like);
      countBinds.push(like, like, like);
    }
    sql += " ORDER BY sort_order, created_at LIMIT ? OFFSET ?";
    binds.push(limit, offset);
    const rows = (await env.DB.prepare(sql).bind(...binds).all<any>()).results;
    const total =
      (
        await env.DB.prepare(countSql)
          .bind(...countBinds)
          .first<{ c: number }>()
      )?.c ?? rows.length;
    const tagMap = await tagsForBookmarks(
      env,
      rows.map((r) => r.id),
    );
    return json({
      items: rows.map((r) => serializeBookmarkRow(r, tagMap.get(r.id) || [])),
      total,
      limit,
      offset,
    });
  }

  if (path === "/bookmarks" && method === "POST") {
    const body = (await req.json()) as any;
    if (!body.url) return err("validation", "url is required");
    const id = uuid();
    const t = now();
    let folderId = body.folder_id;
    if (!folderId) {
      folderId = await getSetting(env, user.id, "inbox_folder_id");
    }
    const folderErr = await assertLiveFolder(env, user.id, folderId);
    if (folderErr) return folderErr;
    const norm = normalizeUrl(body.url);
    const vis = asVisibility(body.visibility);
    const isFavorite = body.is_favorite ? 1 : 0;
    const isArchived = body.is_archived ? 1 : 0;
    await env.DB.prepare(
      `INSERT INTO bookmarks (id, user_id, folder_id, title, url, url_normalized, description, visibility, is_favorite, is_archived, sort_order, link_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'unknown', ?, ?)`,
    )
      .bind(
        id,
        user.id,
        folderId,
        body.title || body.url,
        body.url,
        norm,
        body.description || null,
        vis,
        isFavorite,
        isArchived,
        t,
        t,
      )
      .run();
    let tags: { id: string; name: string; color: string | null }[] = [];
    if (Array.isArray(body.tags)) {
      tags = await setBookmarkTags(env, user.id, id, body.tags);
    }
    await syncFts(
      env,
      { id, title: body.title || body.url, url: body.url, description: body.description },
      tags.map((x) => x.name),
    );
    const snap = {
      id,
      user_id: user.id,
      folder_id: folderId,
      title: body.title || body.url,
      url: body.url,
      url_normalized: norm,
      description: body.description || null,
      visibility: vis,
      is_favorite: !!isFavorite,
      is_archived: !!isArchived,
      sort_order: 0,
      link_status: "unknown",
      deleted_at: null,
      created_at: t,
      updated_at: t,
      tags,
    };
    await writeOp(env, user.id, "bookmark", id, "create", snap);
    // F020: enqueue incremental board scans after bookmark write
    await scheduleBoardScansAfterBookmarkWrite(env, user.id);
    return json(snap);
  }

  if (path.match(/^\/bookmarks\/[^/]+$/) && method === "GET") {
    const id = path.slice("/bookmarks/".length);
    const b = await env.DB.prepare(
      "SELECT * FROM bookmarks WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
      .bind(id, user.id)
      .first<any>();
    if (!b) return err("not_found", "Bookmark not found", 404);
    const tags = await tagsForBookmark(env, id);
    return json({
      ...b,
      is_favorite: !!b.is_favorite,
      is_archived: !!b.is_archived,
      tags,
    });
  }

  if (path.startsWith("/bookmarks/") && method === "PATCH") {
    const id = path.slice("/bookmarks/".length);
    if (id.includes("/")) return err("not_found", `No route ${method} ${path}`, 404);
    const body = (await req.json()) as any;
    const b = await env.DB.prepare(
      "SELECT * FROM bookmarks WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
      .bind(id, user.id)
      .first<any>();
    if (!b) return err("not_found", "Bookmark not found", 404);
    const title = body.title ?? b.title;
    const bmUrl = body.url ?? b.url;
    const description = body.description !== undefined ? body.description : b.description;
    const folder_id = body.folder_id ?? b.folder_id;
    if (body.folder_id !== undefined) {
      const folderErr = await assertLiveFolder(env, user.id, folder_id);
      if (folderErr) return folderErr;
    }
    const visibility = body.visibility ? asVisibility(body.visibility) : b.visibility;
    const norm = body.url ? normalizeUrl(body.url) : b.url_normalized;
    const is_favorite =
      body.is_favorite !== undefined ? (body.is_favorite ? 1 : 0) : b.is_favorite;
    const is_archived =
      body.is_archived !== undefined ? (body.is_archived ? 1 : 0) : b.is_archived;
    const t = now();
    await env.DB.prepare(
      `UPDATE bookmarks SET title=?, url=?, url_normalized=?, description=?, folder_id=?, visibility=?, is_favorite=?, is_archived=?, updated_at=? WHERE id=?`,
    )
      .bind(title, bmUrl, norm, description, folder_id, visibility, is_favorite, is_archived, t, id)
      .run();
    let tags = await tagsForBookmark(env, id);
    if (body.tags !== undefined && Array.isArray(body.tags)) {
      tags = await setBookmarkTags(env, user.id, id, body.tags);
    }
    await syncFts(env, { id, title, url: bmUrl, description }, tags.map((x) => x.name));
    const snap = {
      ...b,
      title,
      url: bmUrl,
      url_normalized: norm,
      description,
      folder_id,
      visibility,
      is_favorite: !!is_favorite,
      is_archived: !!is_archived,
      updated_at: t,
      tags,
    };
    await writeOp(env, user.id, "bookmark", id, "update", snap);
    await scheduleBoardScansAfterBookmarkWrite(env, user.id);
    return json(snap);
  }

  if (path.startsWith("/bookmarks/") && method === "DELETE") {
    const id = path.slice("/bookmarks/".length);
    if (id.includes("/")) return err("not_found", `No route ${method} ${path}`, 404);
    const t = now();
    await env.DB.prepare(
      "UPDATE bookmarks SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    )
      .bind(t, t, id, user.id)
      .run();
    await writeOp(env, user.id, "bookmark", id, "soft_delete", { id });
    return json({ ok: true, id });
  }

  if (path === "/nav/home" && method === "GET") {
    const folders = (
      await env.DB.prepare(
        "SELECT id, parent_id, name, visibility, is_system, sort_order FROM folders WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order",
      )
        .bind(user.id)
        .all<any>()
    ).results;
    const bookmarks = (
      await env.DB.prepare(
        "SELECT id, folder_id, title, url, description, visibility, is_favorite, is_archived, sort_order FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order",
      )
        .bind(user.id)
        .all<any>()
    ).results;
    return json({
      folders: folders.map((f) => ({ ...f, is_system: !!f.is_system })),
      bookmarks: bookmarks.map((b) => ({
        ...b,
        is_favorite: !!b.is_favorite,
        is_archived: !!b.is_archived,
      })),
    });
  }

  // ── Backup (export handled below with format support) ──


  async function ensureRootTags(
    env: Env,
    userId: string,
    rootTags: ParsedTag[],
    tagColors: Record<string, string | null>,
  ) {
    const colors = { ...tagColors };
    for (const t of rootTags) {
      const name = String(t.name || "").trim();
      if (!name) continue;
      if (t.color != null) colors[name] = t.color;
      const existing = await env.DB.prepare(
        "SELECT id, color FROM tags WHERE user_id = ? AND name = ?",
      )
        .bind(userId, name)
        .first<{ id: string; color: string | null }>();
      const tstamp = now();
      if (!existing) {
        const id = uuid();
        await env.DB.prepare(
          "INSERT INTO tags (id, user_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
          .bind(id, userId, name, colors[name] ?? null, tstamp, tstamp)
          .run();
        await writeOp(env, userId, "tag", id, "create", {
          id,
          name,
          color: colors[name] ?? null,
        });
      } else if (
        colors[name] !== undefined &&
        existing.color !== colors[name]
      ) {
        await env.DB.prepare("UPDATE tags SET color=?, updated_at=? WHERE id=?")
          .bind(colors[name] ?? null, tstamp, existing.id)
          .run();
        await writeOp(env, userId, "tag", existing.id, "update", {
          id: existing.id,
          color: colors[name] ?? null,
        });
      }
    }
    for (const [name, color] of Object.entries(colors)) {
      if (color == null) continue;
      const existing = await env.DB.prepare(
        "SELECT id, color FROM tags WHERE user_id = ? AND name = ?",
      )
        .bind(userId, name)
        .first<{ id: string; color: string | null }>();
      if (existing && existing.color !== color) {
        const tstamp = now();
        await env.DB.prepare("UPDATE tags SET color=?, updated_at=? WHERE id=?")
          .bind(color, tstamp, existing.id)
          .run();
      }
    }
  }

  /**
   * Atomic replace_all restore via D1 batch (RQG-F001).
   * Fully validates + plans first; only then soft-deletes and inserts in one batch.
   * On any failure before/inside batch commit, the previous live dataset remains.
   */
  async function atomicReplaceAllRestore(
    items: ParsedBookmark[],
    folderMeta: Map<string, FolderPathMeta> | undefined,
    folderByExportId: Map<string, FolderPathMeta> | undefined,
    rootTags: ParsedTag[],
  ): Promise<Response> {
    const t = now();
    const inbox = await getSetting(env, authed.id, "inbox_folder_id");
    if (!inbox) {
      return err("misconfigured", "inbox_folder_id missing", 500);
    }

    // Snapshot live rows for soft-delete statements (planned, not applied yet)
    const liveBookmarks = (
      await env.DB.prepare(
        "SELECT id FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL",
      )
        .bind(authed.id)
        .all<{ id: string }>()
    ).results;
    const liveFolders = (
      await env.DB.prepare(
        "SELECT id FROM folders WHERE user_id = ? AND deleted_at IS NULL AND is_system = 0",
      )
        .bind(authed.id)
        .all<{ id: string }>()
    ).results;
    const existingTags = (
      await env.DB.prepare(
        "SELECT id, name, color FROM tags WHERE user_id = ? ORDER BY name",
      )
        .bind(authed.id)
        .all<{ id: string; name: string; color: string | null }>()
    ).results;

    // Plan new folder ids (identity-preserving when export ids present)
    const exportIdMap = new Map<string, string>();
    const pathFolderIds = new Map<string, string>();
    const folderInserts: {
      id: string;
      parent_id: string | null;
      name: string;
      sort_order: number;
      visibility: string;
      export_id?: string;
    }[] = [];

    if (folderByExportId && folderByExportId.size) {
      const remaining = new Map(folderByExportId);
      let progress = true;
      while (remaining.size && progress) {
        progress = false;
        for (const [exportId, meta] of [...remaining.entries()]) {
          if (meta.is_system) {
            exportIdMap.set(exportId, inbox);
            remaining.delete(exportId);
            progress = true;
            continue;
          }
          const parentExport = meta.parent_export_id ?? null;
          let parentId: string | null = null;
          if (parentExport && folderByExportId.has(parentExport)) {
            if (!exportIdMap.has(parentExport)) continue;
            parentId = exportIdMap.get(parentExport)!;
          }
          const id = uuid();
          const name = String(meta.name || "").trim() || "Folder";
          const vis = meta.visibility ? asVisibility(meta.visibility) : "private";
          const sortOrder =
            meta.sort_order !== undefined && meta.sort_order !== null
              ? Number(meta.sort_order)
              : 0;
          exportIdMap.set(exportId, id);
          folderInserts.push({
            id,
            parent_id: parentId,
            name,
            sort_order: sortOrder,
            visibility: vis,
            export_id: exportId,
          });
          remaining.delete(exportId);
          progress = true;
        }
      }
      for (const [exportId, meta] of remaining) {
        if (meta.is_system) {
          exportIdMap.set(exportId, inbox);
          continue;
        }
        const id = uuid();
        const name = String(meta.name || "").trim() || "Folder";
        const vis = meta.visibility ? asVisibility(meta.visibility) : "private";
        const sortOrder =
          meta.sort_order !== undefined && meta.sort_order !== null
            ? Number(meta.sort_order)
            : 0;
        exportIdMap.set(exportId, id);
        folderInserts.push({
          id,
          parent_id: null,
          name,
          sort_order: sortOrder,
          visibility: vis,
          export_id: exportId,
        });
      }
    } else if (folderMeta?.size) {
      const keys = [...folderMeta.keys()].sort(
        (a, b) => decodeFolderPathKey(a).length - decodeFolderPathKey(b).length,
      );
      for (const key of keys) {
        const segs = decodeFolderPathKey(key);
        if (!segs.length) continue;
        let parentId: string | null = null;
        const acc: string[] = [];
        for (const seg of segs) {
          acc.push(seg);
          const accKey = encodeFolderPathKey(acc);
          if (pathFolderIds.has(accKey)) {
            parentId = pathFolderIds.get(accKey)!;
            continue;
          }
          const meta = folderMeta.get(accKey);
          const id = uuid();
          const vis = meta?.visibility ? asVisibility(meta.visibility) : "private";
          const sortOrder =
            meta?.sort_order !== undefined && meta.sort_order !== null
              ? Number(meta.sort_order)
              : 0;
          pathFolderIds.set(accKey, id);
          folderInserts.push({
            id,
            parent_id: parentId,
            name: seg,
            sort_order: sortOrder,
            visibility: vis,
          });
          parentId = id;
        }
      }
    }

    // Also plan folder paths referenced only by bookmarks
    for (const it of items) {
      if (it.export_folder_id && exportIdMap.has(it.export_folder_id)) continue;
      const segs = it.folder_path || [];
      if (!segs.length) continue;
      let parentId: string | null = null;
      const acc: string[] = [];
      for (const seg of segs) {
        acc.push(seg);
        const accKey = encodeFolderPathKey(acc);
        if (pathFolderIds.has(accKey) || (folderMeta?.has(accKey) && pathFolderIds.has(accKey))) {
          parentId = pathFolderIds.get(accKey)!;
          if (parentId) continue;
        }
        if (pathFolderIds.has(accKey)) {
          parentId = pathFolderIds.get(accKey)!;
          continue;
        }
        const meta = folderMeta?.get(accKey);
        const id = uuid();
        const vis = meta?.visibility ? asVisibility(meta.visibility) : "private";
        const sortOrder =
          meta?.sort_order !== undefined && meta.sort_order !== null
            ? Number(meta.sort_order)
            : 0;
        pathFolderIds.set(accKey, id);
        folderInserts.push({
          id,
          parent_id: parentId,
          name: seg,
          sort_order: sortOrder,
          visibility: vis,
        });
        parentId = id;
      }
    }

    type BmPlan = {
      id: string;
      folder_id: string;
      title: string;
      url: string;
      url_normalized: string;
      description: string | null;
      visibility: string;
      is_favorite: number;
      is_archived: number;
      sort_order: number;
      tags: string[];
      tag_colors?: Record<string, string | null>;
    };
    const bmPlans: BmPlan[] = [];
    for (const it of items) {
      if (!it.url) continue;
      let folderId = inbox;
      if (it.export_folder_id && exportIdMap.has(it.export_folder_id)) {
        folderId = exportIdMap.get(it.export_folder_id)!;
      } else if (it.folder_path?.length) {
        const key = encodeFolderPathKey(it.folder_path);
        folderId = pathFolderIds.get(key) || inbox;
      }
      bmPlans.push({
        id: uuid(),
        folder_id: folderId,
        title: it.title || it.url,
        url: it.url,
        url_normalized: normalizeUrl(it.url),
        description: it.description || null,
        visibility: it.visibility ? asVisibility(it.visibility) : "private",
        is_favorite: it.is_favorite ? 1 : 0,
        is_archived: it.is_archived ? 1 : 0,
        sort_order:
          it.sort_order !== undefined && it.sort_order !== null
            ? Number(it.sort_order)
            : 0,
        tags: it.tags || [],
        tag_colors: it.tag_colors,
      });
    }

    const desiredTagColors = new Map<string, string | null>();
    const allTagNames = new Set<string>();
    for (const tag of rootTags) {
      const name = String(tag.name || "").trim();
      if (!name) continue;
      allTagNames.add(name);
      desiredTagColors.set(name, tag.color ?? null);
    }
    for (const bm of bmPlans) {
      bm.tags = [...new Set(bm.tags.map((name) => String(name).trim()).filter(Boolean))];
      for (const name of bm.tags) allTagNames.add(name);
      for (const [name, color] of Object.entries(bm.tag_colors || {})) {
        const normalized = name.trim();
        if (normalized) desiredTagColors.set(normalized, color ?? null);
      }
    }

    const existingTagByName = new Map(existingTags.map((tag) => [tag.name, tag]));
    const tagIdByName = new Map<string, string>();
    for (const name of allTagNames) {
      tagIdByName.set(name, existingTagByName.get(name)?.id || uuid());
    }

    type RestoreStageRow = {
      kind: string;
      entity_key: string;
      payload: Record<string, unknown>;
    };
    const restoreId = uuid();
    const stageRows: RestoreStageRow[] = [];
    let operationIndex = 0;
    const stageOperation = (
      entityType: string,
      entityId: string,
      action: string,
      snapshot: unknown,
    ) => {
      stageRows.push({
        kind: "op",
        entity_key: String(operationIndex++).padStart(12, "0"),
        payload: {
          entity_type: entityType,
          entity_id: entityId,
          action,
          snapshot: JSON.stringify(snapshot),
        },
      });
    };

    for (const name of allTagNames) {
      const existing = existingTagByName.get(name);
      const id = tagIdByName.get(name)!;
      const color = desiredTagColors.has(name)
        ? desiredTagColors.get(name) ?? null
        : existing?.color ?? null;
      stageRows.push({ kind: "tag", entity_key: name, payload: { id, name, color } });
      if (!existing) {
        stageOperation("tag", id, "create", { id, name, color });
      } else if (desiredTagColors.has(name) && existing.color !== color) {
        stageOperation("tag", existing.id, "update", { id: existing.id, name, color });
      }
    }

    for (const f of folderInserts) {
      stageRows.push({ kind: "folder", entity_key: f.id, payload: { ...f } });
      stageOperation("folder", f.id, "create", {
        id: f.id,
        name: f.name,
        parent_id: f.parent_id,
        visibility: f.visibility,
        sort_order: f.sort_order,
        export_id: f.export_id,
      });
    }
    let bookmarkTagIndex = 0;
    for (const bm of bmPlans) {
      stageRows.push({ kind: "bookmark", entity_key: bm.id, payload: { ...bm } });
      stageOperation("bookmark", bm.id, "create", {
        id: bm.id,
        url: bm.url,
        folder_id: bm.folder_id,
        tags: bm.tags,
        is_favorite: !!bm.is_favorite,
        is_archived: !!bm.is_archived,
        sort_order: bm.sort_order,
      });
      for (const tagName of bm.tags) {
        stageRows.push({
          kind: "bookmark_tag",
          entity_key: String(bookmarkTagIndex++).padStart(12, "0"),
          payload: { bookmark_id: bm.id, tag_name: tagName },
        });
      }
    }
    for (const b of liveBookmarks) {
      stageRows.push({ kind: "old_bookmark", entity_key: b.id, payload: { id: b.id } });
      stageOperation("bookmark", b.id, "soft_delete", { id: b.id });
    }
    for (const f of liveFolders) {
      stageRows.push({ kind: "old_folder", entity_key: f.id, payload: { id: f.id } });
      stageOperation("folder", f.id, "soft_delete", { id: f.id });
    }
    for (const tag of existingTags) {
      if (!allTagNames.has(tag.name)) {
        stageRows.push({ kind: "delete_tag", entity_key: tag.id, payload: { id: tag.id } });
        stageOperation("tag", tag.id, "delete", { id: tag.id, name: tag.name });
      }
    }

    const stageChunks: string[] = [];
    let chunkRows: string[] = [];
    let chunkBytes = 2;
    for (const row of stageRows) {
      const serialized = JSON.stringify(row);
      const rowBytes = new TextEncoder().encode(serialized).byteLength;
      if (rowBytes + 2 > RESTORE_STAGE_CHUNK_BYTES) {
        return err("restore_too_large", "replace_all contains a row too large for D1 staging", 413);
      }
      if (chunkRows.length && chunkBytes + rowBytes + 1 > RESTORE_STAGE_CHUNK_BYTES) {
        stageChunks.push(`[${chunkRows.join(",")}]`);
        chunkRows = [];
        chunkBytes = 2;
      }
      chunkRows.push(serialized);
      chunkBytes += rowBytes + (chunkRows.length > 1 ? 1 : 0);
    }
    if (chunkRows.length) stageChunks.push(`[${chunkRows.join(",")}]`);

    const cleanupStaging = async () => {
      await env.DB.prepare("DELETE FROM restore_staging WHERE restore_id = ? AND user_id = ?")
        .bind(restoreId, authed.id)
        .run();
    };
    try {
      for (const chunk of stageChunks) {
        await env.DB.prepare(
          `INSERT INTO restore_staging (restore_id, user_id, kind, entity_key, payload)
           SELECT ?, ?,
                  json_extract(value, '$.kind'),
                  json_extract(value, '$.entity_key'),
                  json_extract(value, '$.payload')
           FROM json_each(?)`,
        )
          .bind(restoreId, authed.id, chunk)
          .run();
      }
    } catch (e) {
      await cleanupStaging().catch(() => undefined);
      logError("replace_all_stage_failed", {
        message: e instanceof Error ? e.message : String(e),
      });
      return err("restore_failed", "replace_all staging failed; previous live dataset preserved", 500);
    }

    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO tags (id, user_id, name, color, created_at, updated_at)
         SELECT json_extract(payload, '$.id'), user_id, json_extract(payload, '$.name'),
                json_extract(payload, '$.color'), ?, ?
         FROM restore_staging
         WHERE restore_id = ? AND user_id = ? AND kind = 'tag'
         ON CONFLICT(user_id, name) DO UPDATE SET
           color = excluded.color,
           updated_at = excluded.updated_at
         WHERE tags.color IS NOT excluded.color`,
      ).bind(t, t, restoreId, authed.id),
      env.DB.prepare(
        `INSERT INTO folders
           (id, user_id, parent_id, name, sort_order, visibility, is_system, created_at, updated_at)
         SELECT json_extract(payload, '$.id'), user_id, json_extract(payload, '$.parent_id'),
                json_extract(payload, '$.name'), json_extract(payload, '$.sort_order'),
                json_extract(payload, '$.visibility'), 0, ?, ?
         FROM restore_staging
         WHERE restore_id = ? AND user_id = ? AND kind = 'folder'`,
      ).bind(t, t, restoreId, authed.id),
      env.DB.prepare(
        `INSERT INTO bookmarks
           (id, user_id, folder_id, title, url, url_normalized, description, visibility,
            is_favorite, is_archived, sort_order, link_status, created_at, updated_at)
         SELECT json_extract(payload, '$.id'), user_id, json_extract(payload, '$.folder_id'),
                json_extract(payload, '$.title'), json_extract(payload, '$.url'),
                json_extract(payload, '$.url_normalized'), json_extract(payload, '$.description'),
                json_extract(payload, '$.visibility'), json_extract(payload, '$.is_favorite'),
                json_extract(payload, '$.is_archived'), json_extract(payload, '$.sort_order'),
                'unknown', ?, ?
         FROM restore_staging
         WHERE restore_id = ? AND user_id = ? AND kind = 'bookmark'`,
      ).bind(t, t, restoreId, authed.id),
    ];

    const failureStatement = () =>
      env.DB.prepare(
        "INSERT INTO users (id, username, password_hash, must_change_password, created_at, updated_at) VALUES (?, NULL, ?, 1, ?, ?)",
      ).bind(uuid(), "restore-failure-injection", t, t);
    if (env.RESTORE_TEST_FAIL_PHASE === "insert") statements.push(failureStatement());

    statements.push(
      env.DB.prepare(
        `DELETE FROM bookmark_tags
         WHERE bookmark_id IN (SELECT id FROM bookmarks WHERE user_id = ?)
            OR tag_id IN (SELECT id FROM tags WHERE user_id = ?)`,
      ).bind(authed.id, authed.id),
      env.DB.prepare(
        `INSERT INTO bookmark_tags (bookmark_id, tag_id)
         SELECT json_extract(s.payload, '$.bookmark_id'), t.id
         FROM restore_staging s
         JOIN tags t
           ON t.user_id = s.user_id AND t.name = json_extract(s.payload, '$.tag_name')
         WHERE s.restore_id = ? AND s.user_id = ? AND s.kind = 'bookmark_tag'`,
      ).bind(restoreId, authed.id),
      env.DB.prepare(
        `UPDATE bookmarks SET deleted_at = ?, updated_at = ?
         WHERE id IN (
           SELECT entity_key FROM restore_staging
           WHERE restore_id = ? AND user_id = ? AND kind = 'old_bookmark'
         )`,
      ).bind(t, t, restoreId, authed.id),
      env.DB.prepare(
        `UPDATE folders SET deleted_at = ?, updated_at = ?
         WHERE id IN (
           SELECT entity_key FROM restore_staging
           WHERE restore_id = ? AND user_id = ? AND kind = 'old_folder'
         )`,
      ).bind(t, t, restoreId, authed.id),
      env.DB.prepare(
        `DELETE FROM tags WHERE id IN (
           SELECT entity_key FROM restore_staging
           WHERE restore_id = ? AND user_id = ? AND kind = 'delete_tag'
         )`,
      ).bind(restoreId, authed.id),
      env.DB.prepare(
        `INSERT INTO op_logs (user_id, entity_type, entity_id, action, snapshot, created_at)
         SELECT user_id, json_extract(payload, '$.entity_type'),
                json_extract(payload, '$.entity_id'), json_extract(payload, '$.action'),
                json_extract(payload, '$.snapshot'), ?
         FROM restore_staging
         WHERE restore_id = ? AND user_id = ? AND kind = 'op'
         ORDER BY entity_key`,
      ).bind(t, restoreId, authed.id),
    );
    if (env.RESTORE_TEST_FAIL_PHASE === "swap") statements.push(failureStatement());
    statements.push(
      env.DB.prepare("DELETE FROM restore_staging WHERE restore_id = ? AND user_id = ?").bind(
        restoreId,
        authed.id,
      ),
    );

    try {
      await env.DB.batch(statements);
    } catch (e) {
      await cleanupStaging().catch(() => undefined);
      logError("replace_all_atomic_failed", {
        message: e instanceof Error ? e.message : String(e),
        phase: env.RESTORE_TEST_FAIL_PHASE || "commit",
      });
      return err(
        "restore_failed",
        "replace_all insert phase failed; previous live dataset preserved (atomic swap rolled back)",
        500,
      );
    }

    // FTS is optional derived state. Rebuild it in two bulk queries after cutover.
    try {
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM bookmarks_fts WHERE bookmark_id IN (SELECT id FROM bookmarks WHERE user_id = ?)",
        ).bind(authed.id),
        env.DB.prepare(
          `INSERT INTO bookmarks_fts (bookmark_id, title, url, description, tags)
           SELECT b.id, b.title, b.url, COALESCE(b.description, ''),
                  COALESCE(GROUP_CONCAT(t.name, ' '), '')
           FROM bookmarks b
           LEFT JOIN bookmark_tags bt ON bt.bookmark_id = b.id
           LEFT JOIN tags t ON t.id = bt.tag_id
           WHERE b.user_id = ? AND b.deleted_at IS NULL
           GROUP BY b.id, b.title, b.url, b.description`,
        ).bind(authed.id),
      ]);
    } catch {
      /* optional */
    }

    return json({
      ok: true,
      strategy: "replace_all",
      created: bmPlans.length,
      skipped: 0,
      merged: 0,
      total_input: items.length,
      atomic: true,
      replaced_bookmarks: liveBookmarks.length,
      replaced_folders: liveFolders.length,
    });
  }

  async function importBookmarksFromParsed(
    items: ParsedBookmark[],
    strategy: string,
    confirmReplace?: boolean,
    folderMeta?: Map<string, FolderPathMeta>,
    folderByExportId?: Map<string, FolderPathMeta>,
    rootTags: ParsedTag[] = [],
  ) {
    const opts = validateImportOptions({ format: "json", strategy });
    if (opts.errors.length) {
      return err("validation", opts.errors.join("; "));
    }
    const strat = opts.strategy;

    if (strat === "replace_all") {
      if (!confirmReplace) {
        return err("confirm_required", "replace_all requires confirm_replace=true");
      }
      return atomicReplaceAllRestore(
        items,
        folderMeta,
        folderByExportId,
        rootTags,
      );
    }

    let created = 0;
    let skipped = 0;
    let merged = 0;
    const inbox = await getSetting(env, authed.id, "inbox_folder_id");
    const folderCache = new Map<string, string>();
    let exportIdMap = new Map<string, string>();

    if (folderByExportId?.size) {
      exportIdMap = await ensureFoldersByIdentity(env, authed.id, folderByExportId);
    } else if (folderMeta?.size) {
      // Keys are encodeFolderPathKey(segments) — never slash-split (RQG-BACKUP-001).
      const keys = [...folderMeta.keys()].sort(
        (a, b) => decodeFolderPathKey(a).length - decodeFolderPathKey(b).length,
      );
      for (const key of keys) {
        const segs = decodeFolderPathKey(key);
        if (segs.length) {
          await ensureFolderPath(env, authed.id, segs, folderCache, folderMeta);
        }
      }
    }

    const tagColors: Record<string, string | null> = {};
    for (const t of rootTags) {
      if (t.color != null) tagColors[String(t.name)] = t.color;
    }
    for (const it of items) {
      for (const [n, c] of Object.entries(it.tag_colors || {})) {
        if (c != null) tagColors[n] = c;
      }
    }
    await ensureRootTags(env, authed.id, rootTags, tagColors);

    for (const it of items) {
      if (!it.url) continue;
      const norm = normalizeUrl(it.url);
      let folderId = inbox;
      if (it.export_folder_id && exportIdMap.has(it.export_folder_id)) {
        folderId = exportIdMap.get(it.export_folder_id)!;
      } else if (it.folder_path?.length) {
        folderId = await ensureFolderPath(
          env,
          authed.id,
          it.folder_path,
          folderCache,
          folderMeta,
        );
      }
      if (folderId) {
        const folderErr = await assertLiveFolder(env, authed.id, folderId);
        if (folderErr) return folderErr;
      }
      const hit = await env.DB.prepare(
        `SELECT id, folder_id
         FROM bookmarks
         WHERE user_id = ? AND url_normalized = ? AND deleted_at IS NULL
         ORDER BY CASE WHEN folder_id = ? THEN 0 ELSE 1 END, created_at ASC, id ASC
         LIMIT 1`,
      )
        .bind(authed.id, norm, folderId)
        .first<{ id: string; folder_id: string | null }>();
      if (hit && strat === "skip_duplicate") {
        skipped++;
        continue;
      }
      const fav = it.is_favorite ? 1 : 0;
      const arch = it.is_archived ? 1 : 0;
      const sortOrder =
        it.sort_order !== undefined && it.sort_order !== null
          ? Number(it.sort_order)
          : 0;
      if (hit && strat === "merge") {
        const t = now();
        await env.DB.prepare(
          "UPDATE bookmarks SET title=?, description=COALESCE(?, description), folder_id=COALESCE(?, folder_id), is_favorite=?, is_archived=?, sort_order=?, updated_at=? WHERE id=?",
        )
          .bind(
            it.title || it.url,
            it.description || null,
            folderId || null,
            fav,
            arch,
            sortOrder,
            t,
            hit.id,
          )
          .run();
        let tags: { id: string; name: string; color: string | null }[] = [];
        if (it.tags?.length)
          tags = await setBookmarkTags(
            env,
            authed.id,
            hit.id,
            it.tags,
            it.tag_colors,
          );
        else tags = await tagsForBookmark(env, hit.id);
        await syncFts(
          env,
          { id: hit.id, title: it.title || it.url, url: it.url, description: it.description },
          tags.map((x) => x.name),
        );
        await writeOp(env, authed.id, "bookmark", hit.id, "update", { id: hit.id, merged: true });
        merged++;
        continue;
      }
      const id = uuid();
      const t = now();
      const vis = it.visibility ? asVisibility(it.visibility) : "private";
      await env.DB.prepare(
        `INSERT INTO bookmarks (id, user_id, folder_id, title, url, url_normalized, description, visibility, is_favorite, is_archived, sort_order, link_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
      )
        .bind(
          id,
          authed.id,
          folderId || inbox,
          it.title || it.url,
          it.url,
          norm,
          it.description || null,
          vis,
          fav,
          arch,
          sortOrder,
          t,
          t,
        )
        .run();
      let tags: { id: string; name: string; color: string | null }[] = [];
      if (it.tags?.length)
        tags = await setBookmarkTags(env, authed.id, id, it.tags, it.tag_colors);
      await syncFts(
        env,
        { id, title: it.title || it.url, url: it.url, description: it.description },
        tags.map((x) => x.name),
      );
      await writeOp(env, authed.id, "bookmark", id, "create", {
        id,
        url: it.url,
        folder_id: folderId || inbox,
        tags,
        is_favorite: !!fav,
        is_archived: !!arch,
        sort_order: sortOrder,
      });
      created++;
    }
    return json({
      ok: true,
      strategy: strat,
      created,
      skipped,
      merged,
      total_input: items.length,
    });
  }

  function parseImportPayload(
    format: string,
    content: string,
  ):
    | {
        ok: true;
        items: ParsedBookmark[];
        folderMeta?: Map<string, FolderPathMeta>;
        folderByExportId?: Map<string, FolderPathMeta>;
        rootTags: ParsedTag[];
      }
    | { ok: false; response: Response } {
    if (!["json", "csv", "html"].includes(String(format || "").toLowerCase())) {
      return {
        ok: false,
        response: err("validation", `Unsupported format: ${format}`),
      };
    }
    const fmt = String(format || "json").toLowerCase();
    try {
      if (fmt === "json") {
        const raw = JSON.parse(content) as unknown;
        if (!raw || (typeof raw !== "object" && !Array.isArray(raw))) {
          return { ok: false, response: err("validation", "JSON import must be an array or object") };
        }
        if (!Array.isArray(raw)) {
          const root = raw as Record<string, unknown>;
          if (root.format !== undefined && typeof root.format !== "string") {
            return { ok: false, response: err("validation", "JSON format must be a string") };
          }
          if (root.format === "markhub-json") {
            if (root.version !== 1) {
              return { ok: false, response: err("validation", "unsupported native JSON version") };
            }
            for (const field of ["bookmarks", "folders", "tags"] as const) {
              if (!Array.isArray(root[field])) {
                return {
                  ok: false,
                  response: err("validation", `native JSON ${field} must be an array`),
                };
              }
            }
          } else if (!Array.isArray(root.bookmarks)) {
            return { ok: false, response: err("validation", "JSON bookmarks must be an array") };
          }
        }
        const parsed = parseJsonExport(content);
        const reject = importParseRejection(parsed);
        if (reject) {
          return { ok: false, response: err("validation", reject) };
        }
        return {
          ok: true,
          items: parsed.bookmarks,
          folderMeta: parsed.folder_meta,
          folderByExportId: parsed.folder_by_export_id,
          rootTags: parsed.tags,
        };
      }
      if (fmt === "csv") {
        const metadataMatch = content.match(
          /^# markhub-metadata:([A-Za-z0-9_-]+)\r?\n/,
        );
        const metadata = metadataMatch
          ? decodePortableBackupMetadata(metadataMatch[1]!)
          : null;
        if (metadataMatch && !metadata) {
          return { ok: false, response: err("validation", "invalid CSV MarkHub metadata") };
        }
        const parsed = parseCsv(metadataMatch ? content.slice(metadataMatch[0].length) : content);
        const reject = importParseRejection(parsed);
        if (reject) {
          return { ok: false, response: err("validation", reject) };
        }
        if (metadata) {
          if (metadata.bookmark_folder_ids.length !== parsed.bookmarks.length) {
            return { ok: false, response: err("validation", "CSV metadata row count mismatch") };
          }
          const metaParsed = parseJsonExport(
            JSON.stringify({
              format: "markhub-json",
              version: 1,
              bookmarks: metadata.bookmarks,
              folders: metadata.folders,
              tags: metadata.tags,
            }),
          );
          const metaReject = importParseRejection(metaParsed);
          if (metaReject) return { ok: false, response: err("validation", metaReject) };
          if (
            metaParsed.bookmarks.length !== parsed.bookmarks.length ||
            parsed.bookmarks.some(
              (bookmark, index) => bookmark.url !== metaParsed.bookmarks[index]?.url,
            )
          ) {
            return { ok: false, response: err("validation", "CSV metadata/content mismatch") };
          }
          return {
            ok: true,
            items: metaParsed.bookmarks,
            folderMeta: metaParsed.folder_meta,
            folderByExportId: metaParsed.folder_by_export_id,
            rootTags: metaParsed.tags,
          };
        }
        if (!parsed.bookmarks.length && !parsed.folder_meta.size) {
          return { ok: false, response: err("validation", "CSV contains no restorable records") };
        }
        return {
          ok: true,
          items: parsed.bookmarks,
          folderMeta: parsed.folder_meta,
          rootTags: [],
        };
      }
      if (fmt === "html") {
        const metadataMatch = content.match(
          /<META\s+NAME="markhub-metadata"\s+CONTENT="([A-Za-z0-9_-]+)"\s*>/i,
        );
        const metadata = metadataMatch
          ? decodePortableBackupMetadata(metadataMatch[1]!)
          : null;
        if (metadataMatch && !metadata) {
          return { ok: false, response: err("validation", "invalid HTML MarkHub metadata") };
        }
        const parsed = parseNetscapeHtml(content);
        const reject = importParseRejection(parsed);
        if (reject) {
          return { ok: false, response: err("validation", reject) };
        }
        if (metadata) {
          if (metadata.bookmark_folder_ids.length !== parsed.bookmarks.length) {
            return { ok: false, response: err("validation", "HTML metadata row count mismatch") };
          }
          const metaParsed = parseJsonExport(
            JSON.stringify({
              format: "markhub-json",
              version: 1,
              bookmarks: metadata.bookmarks,
              folders: metadata.folders,
              tags: metadata.tags,
            }),
          );
          const metaReject = importParseRejection(metaParsed);
          if (metaReject) return { ok: false, response: err("validation", metaReject) };
          if (
            metaParsed.bookmarks.length !== parsed.bookmarks.length ||
            parsed.bookmarks.some(
              (bookmark, index) => bookmark.url !== metaParsed.bookmarks[index]?.url,
            )
          ) {
            return { ok: false, response: err("validation", "HTML metadata/content mismatch") };
          }
          return {
            ok: true,
            items: metaParsed.bookmarks,
            folderMeta: metaParsed.folder_meta,
            folderByExportId: metaParsed.folder_by_export_id,
            rootTags: metaParsed.tags,
          };
        }
        if (!parsed.bookmarks.length && !parsed.folder_meta.size) {
          return { ok: false, response: err("validation", "HTML contains no restorable records") };
        }
        return {
          ok: true,
          items: parsed.bookmarks,
          folderMeta: parsed.folder_meta,
          rootTags: [],
        };
      }
      return {
        ok: false,
        response: err("validation", "format must be json, csv, or html"),
      };
    } catch {
      return { ok: false, response: err("validation", "Invalid import content") };
    }
  }

  if (path === "/backup/import" && method === "POST") {
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return err("validation", "request body must be valid JSON");
    }
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return err("validation", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;
    if (typeof body.content !== "string" || !body.content.trim()) {
      return err("validation", "content must be a non-empty string");
    }
    if (body.format !== undefined && typeof body.format !== "string") {
      return err("validation", "format must be a string");
    }
    if (body.strategy !== undefined && typeof body.strategy !== "string") {
      return err("validation", "strategy must be a string");
    }
    if (body.confirm_replace !== undefined && typeof body.confirm_replace !== "boolean") {
      return err("validation", "confirm_replace must be a boolean");
    }
    const optErr = validateImportOptions({
      format: body.format === undefined ? "json" : body.format,
      strategy: body.strategy === undefined ? "skip_duplicate" : body.strategy,
    });
    if (optErr.errors.length) {
      return err("validation", optErr.errors.join("; "));
    }
    const parsed = parseImportPayload(optErr.format, body.content);
    if (!parsed.ok) return parsed.response;
    return importBookmarksFromParsed(
      parsed.items,
      optErr.strategy,
      body.confirm_replace === true,
      parsed.folderMeta,
      parsed.folderByExportId,
      parsed.rootTags,
    );
  }

  if (path === "/backup/import-file" && method === "POST") {
    const ct = req.headers.get("content-type") || "";
    if (!ct.includes("multipart/form-data")) {
      return err("validation", "multipart/form-data required");
    }
    const form = await req.formData();
    const file = form.get("file");
    const strategy = String(form.get("strategy") || "skip_duplicate");
    const confirm = String(form.get("confirm_replace") || "") === "true";
    let format = String(form.get("format") || "").toLowerCase();
    if (!file || typeof file === "string") return err("validation", "file required");
    const name = (file as File).name || "";
    if (!format || format === "json") {
      if (name.endsWith(".csv")) format = "csv";
      else if (name.endsWith(".html") || name.endsWith(".htm")) format = "html";
      else if (!format) format = "json";
    }
    const optErr = validateImportOptions({ format, strategy });
    if (optErr.errors.length) {
      return err("validation", optErr.errors.join("; "));
    }
    const content = await (file as File).text();
    const parsed = parseImportPayload(optErr.format, content);
    if (!parsed.ok) return parsed.response;
    return importBookmarksFromParsed(
      parsed.items,
      optErr.strategy,
      confirm,
      parsed.folderMeta,
      parsed.folderByExportId,
      parsed.rootTags,
    );
  }

  // S3 config — GET?test=true runs connection test before config response
  if (path === "/backup/s3" && method === "GET" && url.searchParams.get("test") === "true") {
    const packed = await getS3Creds(env, user.id);
    if (!packed) {
      return json({ ok: false, code: "s3_config", message: "endpoint and bucket required" });
    }
    const t0 = Date.now();
    try {
      const listed = await s3ListObjects(packed.creds, { maxKeys: 1, timeoutMs: 10_000 });
      if (!listed.ok) {
        return json({
          ok: false,
          code: listed.code || classifyS3Error(listed.status, listed.message),
          message: listed.message,
          latency_ms: Date.now() - t0,
        });
      }
      return json({
        ok: true,
        latency_ms: Date.now() - t0,
        endpoint_reachable: true,
      });
    } catch (e) {
      return json({
        ok: false,
        code: "s3_network",
        message: e instanceof Error ? e.message.slice(0, 200) : "network error",
        latency_ms: Date.now() - t0,
      });
    }
  }
  if (path === "/backup/s3" && method === "GET") {
    const raw = await getSetting(env, user.id, "s3_config");
    let cfg: any = {};
    try {
      cfg = raw ? JSON.parse(raw) : {};
    } catch {
      cfg = {};
    }
    const secret = await getSecretSetting(env, user.id, "s3_secret_access_key");
    return json({
      enabled: !!cfg.enabled,
      endpoint: cfg.endpoint || "",
      region: cfg.region || "auto",
      bucket: cfg.bucket || "",
      key_prefix: cfg.key_prefix || "markhub-backup/",
      access_key_id: cfg.access_key_id || "",
      secret_set: !!secret,
      keep_backups: cfg.keep_backups || 7,
      backup_time: cfg.backup_time || "02:00",
      force_path_style: cfg.force_path_style !== false,
      last_backup_at: cfg.last_backup_at || null,
    });
  }
  if (path === "/backup/s3" && method === "PUT") {
    const body = (await req.json()) as any;
    const prev = await getSetting(env, user.id, "s3_config");
    let cfg: any = {};
    try {
      cfg = prev ? JSON.parse(prev) : {};
    } catch {
      cfg = {};
    }
    for (const k of [
      "enabled",
      "endpoint",
      "region",
      "bucket",
      "access_key_id",
      "keep_backups",
      "backup_time",
      "force_path_style",
    ]) {
      if (body[k] !== undefined) cfg[k] = body[k];
    }
    if (body.key_prefix !== undefined) {
      let p = String(body.key_prefix || "").replace(/^\//, "");
      if (p && !p.endsWith("/")) p += "/";
      cfg.key_prefix = p;
    }
    const secretAlready = !!(await getSetting(env, user.id, "s3_secret_access_key"));
    const v = validateS3Config(
      {
        endpoint: cfg.endpoint || "",
        region: cfg.region || "auto",
        bucket: cfg.bucket || "",
        key_prefix: cfg.key_prefix || "markhub-backup/",
        access_key_id: cfg.access_key_id || "",
        secret_access_key: body.secret_access_key || "",
        keep_backups: cfg.keep_backups ?? 7,
        backup_time: cfg.backup_time || "02:00",
        enabled: !!cfg.enabled,
      },
      { requireSecrets: !!cfg.enabled && !secretAlready },
    );
    // Always reject invalid formats for provided fields
    const format = validateS3Config(
      {
        endpoint: body.endpoint !== undefined ? body.endpoint : cfg.endpoint || "https://placeholder.example.com",
        region: body.region !== undefined ? body.region : cfg.region || "auto",
        bucket: body.bucket !== undefined ? body.bucket : cfg.bucket || "placeholder-bucket",
        access_key_id: "x",
        secret_access_key: "y",
        keep_backups: body.keep_backups !== undefined ? body.keep_backups : cfg.keep_backups ?? 7,
        backup_time: body.backup_time !== undefined ? body.backup_time : cfg.backup_time || "02:00",
      },
      { requireSecrets: false },
    );
    if (!format.ok) {
      return err("validation", format.errors.join("; "));
    }
    if (cfg.enabled && !v.ok) {
      return err("validation", v.errors.join("; "));
    }
    if (body.secret_access_key) {
      await setSetting(env, user.id, "s3_secret_access_key", String(body.secret_access_key), true);
    }
    await setSetting(env, user.id, "s3_config", JSON.stringify(cfg));
    return handleApi(
      new Request(req.url, { method: "GET", headers: req.headers }),
      env,
      "/backup/s3",
    );
  }
  if (path === "/backup/s3/test" && method === "POST") {
    const packed = await getS3Creds(env, user.id);
    if (!packed) {
      return json({ ok: false, code: "s3_config", message: "endpoint and bucket required" });
    }
    const t0 = Date.now();
    try {
      const listed = await s3ListObjects(packed.creds, { maxKeys: 1, timeoutMs: 10_000 });
      if (!listed.ok) {
        return json({
          ok: false,
          code: listed.code || classifyS3Error(listed.status, listed.message),
          message: listed.message,
          latency_ms: Date.now() - t0,
        });
      }
      return json({
        ok: true,
        latency_ms: Date.now() - t0,
        endpoint_reachable: true,
      });
    } catch (e) {
      return json({
        ok: false,
        code: "s3_network",
        message: e instanceof Error ? e.message.slice(0, 200) : "network error",
        latency_ms: Date.now() - t0,
      });
    }
  }
  if (path === "/backup/s3" && method === "POST") {
    const result = await runS3Backup(env, user.id);
    if (!result.ok) {
      metrics.backup_s3_fail++;
      logError("backup_s3_failed", { code: result.code, message: result.message });
      return err(result.code, result.message, 400);
    }
    metrics.backup_s3_ok++;
    logInfo("backup_s3_ok", { key: result.key });
    return json(result);
  }

  // ── Boards ──
  if (path === "/boards" && method === "GET") {
    const rows = (
      await env.DB.prepare("SELECT * FROM boards WHERE user_id = ? ORDER BY created_at DESC")
        .bind(user.id)
        .all<any>()
    ).results;
    return json({
      items: rows.map((b) => ({
        ...b,
        source_folder_ids: JSON.parse(b.source_folder_ids || "[]"),
      })),
    });
  }
  if (path === "/boards" && method === "POST") {
    const body = (await req.json()) as any;
    const id = uuid();
    const t = now();
    await env.DB.prepare(
      `INSERT INTO boards (id, user_id, name, type, source_folder_ids, schema_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        id,
        user.id,
        body.name,
        body.type || "ai_channels",
        JSON.stringify(body.source_folder_ids || []),
        t,
        t,
      )
      .run();
    await writeOp(env, user.id, "board", id, "create", { id, name: body.name });
    return json({
      id,
      user_id: user.id,
      name: body.name,
      type: body.type || "ai_channels",
      source_folder_ids: body.source_folder_ids || [],
      schema_version: 1,
      created_at: t,
      updated_at: t,
    });
  }
  if (path.match(/^\/boards\/[^/]+$/) && method === "GET") {
    const boardId = path.slice("/boards/".length);
    const b = await env.DB.prepare("SELECT * FROM boards WHERE id = ? AND user_id = ?")
      .bind(boardId, user.id)
      .first<any>();
    if (!b) return err("not_found", "Board not found", 404);
    return json({
      ...b,
      source_folder_ids: JSON.parse(b.source_folder_ids || "[]"),
    });
  }
  if (path.match(/^\/boards\/[^/]+$/) && method === "PATCH") {
    const boardId = path.slice("/boards/".length);
    const body = (await req.json()) as any;
    const b = await env.DB.prepare("SELECT * FROM boards WHERE id = ? AND user_id = ?")
      .bind(boardId, user.id)
      .first<any>();
    if (!b) return err("not_found", "Board not found", 404);
    const name = body.name ?? b.name;
    const type = body.type ?? b.type;
    const source_folder_ids =
      body.source_folder_ids !== undefined
        ? body.source_folder_ids
        : JSON.parse(b.source_folder_ids || "[]");
    const t = now();
    await env.DB.prepare(
      "UPDATE boards SET name=?, type=?, source_folder_ids=?, updated_at=? WHERE id=?",
    )
      .bind(name, type, JSON.stringify(source_folder_ids), t, boardId)
      .run();
    await writeOp(env, user.id, "board", boardId, "update", { id: boardId, name });
    if (body.source_folder_ids !== undefined) {
      try {
        await runBoardScan(env, user.id, boardId, "full");
      } catch (e) {
        logWarn("board_source_scan_fail", {
          board_id: boardId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return json({
      ...b,
      name,
      type,
      source_folder_ids,
      updated_at: t,
    });
  }
  if (path.match(/^\/boards\/[^/]+$/) && method === "DELETE") {
    const boardId = path.slice("/boards/".length);
    const b = await env.DB.prepare("SELECT id FROM boards WHERE id = ? AND user_id = ?")
      .bind(boardId, user.id)
      .first();
    if (!b) return err("not_found", "Board not found", 404);
    await env.DB.prepare("DELETE FROM annotations WHERE board_id = ?").bind(boardId).run();
    await env.DB.prepare("DELETE FROM board_groups WHERE board_id = ?").bind(boardId).run();
    await env.DB.prepare("DELETE FROM boards WHERE id = ? AND user_id = ?")
      .bind(boardId, user.id)
      .run();
    await writeOp(env, user.id, "board", boardId, "delete", { id: boardId });
    return json({ ok: true, id: boardId });
  }
  if (path.match(/^\/boards\/[^/]+\/scan$/) && method === "POST") {
    const boardId = path.split("/")[2]!;
    let mode: "full" | "incremental" = "full";
    try {
      const body = (await req.json()) as { mode?: string };
      if (body.mode === "incremental") mode = "incremental";
    } catch { /* empty body */ }
    try {
      const result = await runBoardScan(env, user.id, boardId, mode);
      return json(result);
    } catch (e) {
      return err("not_found", e instanceof Error ? e.message : "scan failed", 404);
    }
  }
  if (path.match(/^\/boards\/[^/]+\/annotations$/) && method === "GET") {
    const boardId = path.split("/")[2]!;
    const board = await env.DB.prepare("SELECT id FROM boards WHERE id = ? AND user_id = ?")
      .bind(boardId, user.id)
      .first();
    if (!board) return err("not_found", "Board not found", 404);
    const rows = (
      await env.DB.prepare(
        "SELECT * FROM annotations WHERE board_id = ? ORDER BY last_seen_at DESC",
      )
        .bind(boardId)
        .all()
    ).results;
    return json({ items: rows.map((r) => serializeAnnotationRow(r)) });
  }
  if (path.match(/^\/boards\/[^/]+\/annotations\/batch$/) && method === "POST") {
    const boardId = path.split("/")[2]!;
    const board = await env.DB.prepare("SELECT id FROM boards WHERE id = ? AND user_id = ?")
      .bind(boardId, user.id)
      .first();
    if (!board) return err("not_found", "Board not found", 404);
    const body = (await req.json()) as {
      atomic?: boolean;
      items?: { annotation_id: string; patch: Record<string, unknown> }[];
    };
    const items = (body.items || []).slice(0, 500);
    let updated = 0;
    for (const it of items) {
      const row = await env.DB.prepare(
        "SELECT * FROM annotations WHERE id=? AND board_id=?",
      )
        .bind(it.annotation_id, boardId)
        .first<any>();
      if (!row) {
        if (body.atomic !== false) return err("not_found", `Annotation ${it.annotation_id}`, 404);
        continue;
      }
      const p = it.patch || {};
      await env.DB.prepare(
        `UPDATE annotations SET
          status=COALESCE(?, status), risk=COALESCE(?, risk), price_tag=COALESCE(?, price_tag),
          note=COALESCE(?, note), category=COALESCE(?, category), group_id=COALESCE(?, group_id),
          secondary_group_ids=COALESCE(?, secondary_group_ids), annotation_updated_at=?
         WHERE id=?`,
      )
        .bind(
          (p.status as string) ?? null,
          (p.risk as string) ?? null,
          (p.price_tag as string) ?? null,
          (p.note as string) ?? null,
          (p.category as string) ?? null,
          (p.group_id as string) ?? null,
          p.secondary_group_ids !== undefined
            ? JSON.stringify(p.secondary_group_ids)
            : null,
          now(),
          it.annotation_id,
        )
        .run();
      await writeOp(env, user.id, "annotation", it.annotation_id, "update", {
        board_id: boardId,
        patch: p,
      });
      updated++;
    }
    return json({ ok: true, updated, count: items.length });
  }
  // board import moved below

  if (path.match(/^\/boards\/[^/]+\/export$/) && method === "POST") {
    const boardId = path.split("/")[2]!;
    const board = await env.DB.prepare("SELECT * FROM boards WHERE id = ? AND user_id = ?")
      .bind(boardId, user.id)
      .first<any>();
    if (!board) return err("not_found", "Board not found", 404);
    const annotations = (
      await env.DB.prepare("SELECT * FROM annotations WHERE board_id = ?").bind(boardId).all()
    ).results;
    const groups = (
      await env.DB.prepare("SELECT * FROM board_groups WHERE board_id = ? ORDER BY sort_order")
        .bind(boardId)
        .all()
    ).results;
    let format = "json";
    try {
      const body = (await req.json()) as { format?: string };
      if (body.format) format = body.format;
    } catch {
      /* empty */
    }
    if (format === "html") {
      const rows = annotations
        .map(
          (a: any) =>
            `<li data-status="${escapeHtml(a.status || "")}">${escapeHtml(a.bookmark_id)} — ${escapeHtml(a.note || "")}</li>`,
        )
        .join("\n");
      const title = escapeHtml(board.name || "Board");
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><ul>${rows}</ul></body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return json({
      board: { ...board, source_folder_ids: JSON.parse(board.source_folder_ids || "[]") },
      groups,
      annotations: annotations.map((a) => serializeAnnotationRow(a)),
    });
  }

  // ── AI ──
  if (path === "/ai/status" && method === "GET") {
    const key = await getSecretSetting(env, user.id, "ai_api_key");
    return json({
      configured: !!key,
      model: (await getSetting(env, user.id, "ai_model")) || "gpt-4o-mini",
      provider: (await getSetting(env, user.id, "ai_provider")) || "openai",
      base_url: (await getSetting(env, user.id, "ai_base_url")) || "",
    });
  }
  if (path === "/ai/chat" && method === "POST") {
    // Workers: transform provider SSE into shared MarkHub {delta}/{done} schema (F012)
    const body = (await req.json()) as { messages?: { role: string; content: string }[] };
    const key = await getSecretSetting(env, user.id, "ai_api_key");
    if (!key) return err("ai_not_configured", "AI API key not set");
    const base = (await getSetting(env, user.id, "ai_base_url")) || "https://api.openai.com/v1";
    const model = (await getSetting(env, user.id, "ai_model")) || "gpt-4o-mini";
    const stream = url.searchParams.get("stream") !== "false";
    const r = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are MarkHub assistant." },
          ...(body.messages || []),
        ],
        stream,
      }),
    });
    if (stream && r.ok && r.body) {
      return new Response(transformProviderSseToMarkHub(r.body), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }
    if (!r.ok) {
      const text = await r.text();
      return err("ai_error", text.slice(0, 300), r.status >= 400 ? r.status : 502);
    }
    const data = (await r.json()) as any;
    return json({
      reply: data.choices?.[0]?.message?.content || "",
      model,
    });
  }

  // ── Settings ──
  if (path === "/settings" && method === "GET") {
    const rows = (
      await env.DB.prepare("SELECT key, value, is_secret FROM settings WHERE user_id = ?")
        .bind(user.id)
        .all<any>()
    ).results;
    const out: Record<string, unknown> = {
      theme: "system",
      language: "auto",
      site_title: "MarkHub",
      card_density: "comfortable",
    };
    for (const r of rows) {
      if (r.is_secret) out[`${r.key}_set`] = true;
      else {
        try {
          out[r.key] = JSON.parse(r.value);
        } catch {
          out[r.key] = r.value;
        }
      }
    }
    return json(out);
  }
  if (path === "/settings" && method === "PUT") {
    const body = (await req.json()) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue;
      const val = typeof v === "string" ? v : JSON.stringify(v);
      await setSetting(env, user.id, k, val);
    }
    return handleApi(new Request(req.url, { method: "GET", headers: req.headers }), env, "/settings");
  }

  // Discover (R4-F017)
  if (path === "/discover/widgets" && method === "GET") {
    const wantedRaw = url.searchParams.get("ids") || "";
    const wanted = wantedRaw
      ? wantedRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : ["github_trending", "newsnow", "info_entries"];
    const widgets: Record<string, any[]> = {};
    for (const wid of wanted) {
      try {
        if (wid === "info_entries") {
          const raw = await getSetting(env, user.id, "info_entries");
          let entries: any[] = [];
          try {
            entries = raw ? JSON.parse(raw) : [];
          } catch {
            entries = [];
          }
          if (!Array.isArray(entries)) entries = [];
          widgets[wid] = entries
            .filter((e) => e && typeof e === "object")
            .slice(0, 20)
            .map((e) => ({
              title: String(e.title || e.name || "Entry"),
              url: String(e.url || "#"),
              meta: String(e.meta || e.note || ""),
            }));
        } else if (wid === "github_trending") {
          const r = await safeFetch(
            "https://api.github.com/search/repositories?q=stars:>1&sort=stars&order=desc&per_page=10",
            {
              method: "GET",
              timeoutMs: 8000,
              maxRedirects: 2,
              headers: {
                Accept: "application/vnd.github+json",
              },
            },
          );
          if (!r.ok) {
            widgets[wid] = [];
            continue;
          }
          const data = (await r.json()) as any;
          const items = data.items || [];
          widgets[wid] = items.slice(0, 10).map((it: any) => ({
            title: it.full_name || it.name || "repo",
            url: it.html_url || "#",
            meta: `★ ${it.stargazers_count || 0}`,
          }));
        } else if (wid === "newsnow") {
          try {
            const r = await safeFetch(
              "https://newsnow.busiyi.world/api/s?id=toutiao&latest",
              { method: "GET", timeoutMs: 8000, maxRedirects: 2 },
            );
            if (!r.ok) {
              widgets[wid] = [];
              continue;
            }
            const data = (await r.json()) as any;
            let items = data.items || data.data || [];
            if (items && typeof items === "object" && !Array.isArray(items)) {
              items = items.items || [];
            }
            widgets[wid] = (Array.isArray(items) ? items : []).slice(0, 10).map((it: any) => ({
              title: String(it.title || it.name || "news"),
              url: String(it.url || it.mobileUrl || "#"),
              meta: String(it.extra || it.pubDate || ""),
            }));
          } catch {
            widgets[wid] = [];
          }
        } else {
          widgets[wid] = [];
        }
      } catch {
        widgets[wid] = [];
      }
    }
    return json({ widgets });
  }

  // Changes
  if (path === "/changes" && method === "GET") {
    const since = Number(url.searchParams.get("since") || 0);
    const rows = (
      await env.DB.prepare(
        "SELECT * FROM op_logs WHERE user_id = ? AND id > ? ORDER BY id LIMIT 500",
      )
        .bind(user.id, since)
        .all<any>()
    ).results;
    return json({
      changes: rows,
      next_cursor: rows.length ? rows[rows.length - 1].id : since,
      has_more: rows.length >= 500,
    });
  }

  // ── Bookmark reorder / batch ──
  if (path === "/bookmarks/reorder" && method === "POST") {
    const body = (await req.json()) as { folder_id?: string; ordered_ids: string[] };
    const folderId = body.folder_id || "";
    if (body.folder_id) {
      const folderErr = await assertLiveFolder(env, user.id, body.folder_id);
      if (folderErr) return folderErr;
    }
    const t = now();
    let i = 0;
    for (const id of body.ordered_ids || []) {
      if (body.folder_id) {
        await env.DB.prepare(
          "UPDATE bookmarks SET sort_order = ?, folder_id = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        )
          .bind(i, body.folder_id, t, id, user.id)
          .run();
      } else {
        await env.DB.prepare(
          "UPDATE bookmarks SET sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        )
          .bind(i, t, id, user.id)
          .run();
      }
      i++;
    }
    await touchReorderClock(env, user.id, "bookmark", folderId);
    await writeOp(env, user.id, "reorder", folderId || "root", "reorder", {
      scope: "bookmark",
      parent_id: folderId,
      ordered_ids: body.ordered_ids,
    });
    return json({ ok: true, ordered_ids: body.ordered_ids });
  }
  if (path === "/bookmarks/batch" && method === "POST") {
    const body = (await req.json()) as {
      action: string;
      ids: string[];
      payload?: {
        folder_id?: string;
        visibility?: string;
        is_archived?: boolean;
        tags?: string[];
      };
      // legacy top-level fields (compat)
      folder_id?: string;
      visibility?: string;
      is_archived?: boolean;
    };
    const payload = {
      folder_id: body.folder_id,
      visibility: body.visibility,
      is_archived: body.is_archived,
      ...(body.payload || {}),
    };
    if (body.action === "move" && payload.folder_id) {
      const folderErr = await assertLiveFolder(env, user.id, payload.folder_id);
      if (folderErr) return folderErr;
    }
    const t = now();
    let n = 0;
    for (const id of body.ids || []) {
      const row = await env.DB.prepare(
        "SELECT id FROM bookmarks WHERE id=? AND user_id=? AND deleted_at IS NULL",
      )
        .bind(id, user.id)
        .first();
      if (!row) continue;
      if (body.action === "delete") {
        await env.DB.prepare(
          "UPDATE bookmarks SET deleted_at=?, updated_at=? WHERE id=? AND user_id=?",
        )
          .bind(t, t, id, user.id)
          .run();
        await writeOp(env, user.id, "bookmark", id, "soft_delete", { id });
        n++;
      } else if (body.action === "move" && payload.folder_id) {
        await env.DB.prepare(
          "UPDATE bookmarks SET folder_id=?, updated_at=? WHERE id=? AND user_id=?",
        )
          .bind(payload.folder_id, t, id, user.id)
          .run();
        await writeOp(env, user.id, "bookmark", id, "update", {
          id,
          folder_id: payload.folder_id,
        });
        n++;
      } else if (body.action === "set_visibility" && payload.visibility) {
        await env.DB.prepare(
          "UPDATE bookmarks SET visibility=?, updated_at=? WHERE id=? AND user_id=?",
        )
          .bind(asVisibility(payload.visibility), t, id, user.id)
          .run();
        await writeOp(env, user.id, "bookmark", id, "update", {
          id,
          visibility: payload.visibility,
        });
        n++;
      } else if (body.action === "set_archived") {
        const arch = payload.is_archived !== undefined ? !!payload.is_archived : true;
        await env.DB.prepare(
          "UPDATE bookmarks SET is_archived=?, updated_at=? WHERE id=? AND user_id=?",
        )
          .bind(arch ? 1 : 0, t, id, user.id)
          .run();
        await writeOp(env, user.id, "bookmark", id, "update", { id, is_archived: arch });
        n++;
      } else if (body.action === "set_tags") {
        await setBookmarkTags(env, user.id, id, payload.tags || []);
        await writeOp(env, user.id, "bookmark", id, "update", { id, tags: payload.tags || [] });
        n++;
      } else {
        return err("validation", `Unknown batch action: ${body.action}`);
      }
    }
    return json({ ok: true, affected: n, count: n });
  }

  // Tag update/delete
  if (path.startsWith("/tags/") && method === "PATCH") {
    const id = path.slice("/tags/".length);
    const body = (await req.json()) as any;
    const row = await env.DB.prepare("SELECT * FROM tags WHERE id=? AND user_id=?")
      .bind(id, user.id)
      .first<any>();
    if (!row) return err("not_found", "Tag not found", 404);
    const name = body.name ?? row.name;
    const color = body.color !== undefined ? body.color : row.color;
    await env.DB.prepare("UPDATE tags SET name=?, color=?, updated_at=? WHERE id=?")
      .bind(name, color, now(), id)
      .run();
    await writeOp(env, user.id, "tag", id, "update", { id, name });
    return json({ ...row, name, color });
  }
  if (path.startsWith("/tags/") && method === "DELETE") {
    const id = path.slice("/tags/".length);
    await env.DB.prepare("DELETE FROM bookmark_tags WHERE tag_id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM tags WHERE id=? AND user_id=?").bind(id, user.id).run();
    await writeOp(env, user.id, "tag", id, "delete", { id });
    return json({ ok: true, id });
  }

  // Cleaner + analytics
  if (path === "/clean/jobs" && method === "POST") {
    if (!user) return err("unauthorized", "Missing token", 401);
    const body = (await req.json().catch(() => ({}))) as {
      check_invalid?: boolean;
      concurrency?: number;
    };
    const jobId = uuid();
    const t = now();
    const checkInvalid = !!body.check_invalid;
    const concurrency = Math.min(Math.max(Number(body.concurrency) || 8, 1), 16);
    const cleanUserId = user.id;
    try {
      await env.DB.prepare(
        "INSERT INTO clean_jobs (id, user_id, status, check_invalid, concurrency, progress, created_at) VALUES (?, ?, 'running', ?, ?, 0, ?)",
      )
        .bind(jobId, cleanUserId, checkInvalid ? 1 : 0, concurrency, t)
        .run();
    } catch {
      /* schema optional */
    }
    const bms = (
      await env.DB.prepare("SELECT * FROM bookmarks WHERE user_id=? AND deleted_at IS NULL")
        .bind(cleanUserId)
        .all<any>()
    ).results;
    const folders = (
      await env.DB.prepare("SELECT * FROM folders WHERE user_id=? AND deleted_at IS NULL")
        .bind(cleanUserId)
        .all<any>()
    ).results;
    const issues: any[] = [];
    async function addIssue(
      kind: string,
      entity_type: string,
      entity_id: string,
      detail: string,
    ) {
      const iid = uuid();
      issues.push({ id: iid, kind, entity_type, entity_id, detail });
      try {
        await env.DB.prepare(
          "INSERT INTO clean_issues (id, job_id, user_id, kind, entity_type, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(iid, jobId, cleanUserId, kind, entity_type, entity_id, detail, t)
          .run();
      } catch {
        /* ignore */
      }
    }
    const byNorm = new Map<string, any[]>();
    for (const b of bms) {
      const n = b.url_normalized || normalizeUrl(b.url);
      const g = byNorm.get(n) || [];
      g.push(b);
      byNorm.set(n, g);
      // Broken / unsupported URL scheme (R4-F006)
      try {
        const u = new URL(b.url.includes("://") ? b.url : `https://${b.url}`);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          await addIssue("broken-url", "bookmark", b.id, `Unsupported protocol: ${u.protocol}`);
        } else {
          const safe = assertSafeUrl(u.toString());
          if (!safe.ok) {
            await addIssue("broken-url", "bookmark", b.id, `Blocked/unsafe URL: ${safe.reason}`);
          }
        }
      } catch {
        await addIssue("broken-url", "bookmark", b.id, "URL parse failed");
      }
    }
    for (const [, group] of byNorm) {
      if (group.length < 2) continue;
      const ordered = [...group].sort((a, b) =>
        String(a.created_at).localeCompare(String(b.created_at)),
      );
      for (const dup of ordered.slice(1)) {
        await addIssue("duplicate", "bookmark", dup.id, `Duplicate of ${ordered[0].id}`);
      }
    }
    const bmCount = new Map<string, number>();
    for (const b of bms) bmCount.set(b.folder_id, (bmCount.get(b.folder_id) || 0) + 1);
    const childCount = new Map<string | null, number>();
    for (const f of folders) childCount.set(f.parent_id, (childCount.get(f.parent_id) || 0) + 1);
    for (const f of folders) {
      if (f.is_system) continue;
      if ((bmCount.get(f.id) || 0) === 0 && (childCount.get(f.id) || 0) === 0) {
        await addIssue("empty-folder", "folder", f.id, `Empty folder: ${f.name}`);
      }
    }
    // Bounded network invalid checks with SSRF protection
    if (checkInvalid) {
      const candidates = bms.filter((b) => {
        try {
          const u = new URL(b.url.includes("://") ? b.url : `https://${b.url}`);
          return assertSafeUrl(u.toString()).ok;
        } catch {
          return false;
        }
      });
      // Cap network checks on Workers CPU/time budget
      const maxChecks = Math.min(candidates.length, 40);
      let done = 0;
      for (let i = 0; i < maxChecks; i += concurrency) {
        const slice = candidates.slice(i, i + concurrency);
        await Promise.all(
          slice.map(async (b) => {
            try {
              const target = b.url.includes("://") ? b.url : `https://${b.url}`;
              const r = await safeFetch(target, {
                method: "HEAD",
                timeoutMs: 5000,
                maxRedirects: 2,
              });
              if (r.status >= 400 && r.status !== 405) {
                await addIssue(
                  "invalid",
                  "bookmark",
                  b.id,
                  `HTTP ${r.status} for ${b.url.slice(0, 120)}`,
                );
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : "fetch failed";
              if ((e as any)?.code === "ssrf") {
                await addIssue("broken-url", "bookmark", b.id, msg);
              } else {
                await addIssue("invalid", "bookmark", b.id, msg.slice(0, 200));
              }
            }
            done++;
            try {
              await env.DB.prepare("UPDATE clean_jobs SET progress=? WHERE id=?")
                .bind(done / maxChecks, jobId)
                .run();
            } catch {
              /* ignore */
            }
          }),
        );
      }
    }
    try {
      await env.DB.prepare(
        "UPDATE clean_jobs SET status='done', progress=1, finished_at=? WHERE id=?",
      )
        .bind(now(), jobId)
        .run();
    } catch {
      /* ignore */
    }
    return json({ id: jobId, status: "done", issue_count: issues.length, issues });
  }
  if (path.startsWith("/clean/jobs/") && method === "GET") {
    const jobId = path.slice("/clean/jobs/".length);
    let issues: any[] = [];
    try {
      issues = (
        await env.DB.prepare("SELECT * FROM clean_issues WHERE job_id=?").bind(jobId).all()
      ).results;
    } catch {
      issues = [];
    }
    return json({ id: jobId, status: "done", issue_count: issues.length, issues });
  }
  if (path === "/clean/apply" && method === "POST") {
    const body = (await req.json()) as { issue_ids: string[]; mark_link_status?: boolean };
    const t = now();
    let applied = 0;
    for (const iid of body.issue_ids || []) {
      const issue = await env.DB.prepare(
        "SELECT * FROM clean_issues WHERE id=? AND user_id=?",
      )
        .bind(iid, user.id)
        .first<any>();
      if (!issue) continue;
      if (issue.entity_type === "bookmark") {
        await env.DB.prepare(
          "UPDATE bookmarks SET deleted_at=?, updated_at=? WHERE id=? AND user_id=?",
        )
          .bind(t, t, issue.entity_id, user.id)
          .run();
        await writeOp(env, user.id, "bookmark", issue.entity_id, "soft_delete", {
          from: "clean",
        });
        applied++;
      } else if (issue.entity_type === "folder") {
        await env.DB.prepare(
          "UPDATE folders SET deleted_at=?, updated_at=? WHERE id=? AND user_id=? AND is_system=0",
        )
          .bind(t, t, issue.entity_id, user.id)
          .run();
        applied++;
      }
    }
    return json({ ok: true, applied });
  }
  if (path === "/analytics/profile" && method === "GET") {
    const bms = (
      await env.DB.prepare("SELECT * FROM bookmarks WHERE user_id=? AND deleted_at IS NULL")
        .bind(user.id)
        .all<any>()
    ).results;
    const folders = (
      await env.DB.prepare(
        "SELECT id FROM folders WHERE user_id=? AND deleted_at IS NULL",
      )
        .bind(user.id)
        .all()
    ).results;
    const domains = new Map<string, number>();
    for (const b of bms) {
      try {
        const host = new URL(b.url.includes("://") ? b.url : `https://${b.url}`).hostname.replace(
          /^www\./,
          "",
        );
        domains.set(host, (domains.get(host) || 0) + 1);
      } catch {
        /* ignore */
      }
    }
    const top = [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    return json({
      total_bookmarks: bms.length,
      total_folders: folders.length,
      top_domains: top.map(([domain, count]) => ({ domain, count })),
      added_last_30_days: bms.length,
      favorites: bms.filter((b) => b.is_favorite).length,
      archived: bms.filter((b) => b.is_archived).length,
      by_visibility: {
        public: bms.filter((b) => b.visibility === "public").length,
        unlisted: bms.filter((b) => b.visibility === "unlisted").length,
        private: bms.filter((b) => b.visibility === "private").length,
      },
    });
  }

  // Shares
  if (path === "/shares" && method === "GET") {
    const rows = (
      await env.DB.prepare(
        "SELECT * FROM share_links WHERE user_id=? ORDER BY created_at DESC",
      )
        .bind(user.id)
        .all<any>()
    ).results;
    return json({
      items: rows.map((r) => ({
        id: r.id,
        token: String(r.token).slice(0, 6) + "…",
        target_type: r.target_type,
        target_id: r.target_id,
        has_password: !!r.password_hash,
        expires_at: r.expires_at || null,
        created_at: r.created_at,
      })),
    });
  }
  if (path === "/shares" && method === "POST") {
    const body = (await req.json()) as any;
    const token = b64url(crypto.getRandomValues(new Uint8Array(12)));
    const id = uuid();
    const t = now();
    let ph: string | null = null;
    if (body.password) ph = await hashPassword(body.password);
    const expiresAt = normalizeShareExpiry(body.expires_at);
    if (expiresAt instanceof Response) return expiresAt;
    await env.DB.prepare(
      "INSERT INTO share_links (id, user_id, token, target_type, target_id, password_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, user.id, token, body.target_type, body.target_id, ph, expiresAt, t)
      .run();
    return json({
      id,
      token,
      target_type: body.target_type,
      target_id: body.target_id,
      has_password: !!body.password,
      expires_at: expiresAt,
      url_path: `/s/${token}`,
    });
  }
  if (path.startsWith("/shares/") && method === "DELETE") {
    const token = path.slice("/shares/".length);
    await env.DB.prepare("DELETE FROM share_links WHERE token=? AND user_id=?")
      .bind(token, user.id)
      .run();
    return json({ ok: true });
  }

  // AI settings (R4-F004) — FastAPI-compatible field names
  if (path === "/settings/ai" && method === "GET") {
    const key = await getSecretSetting(env, user.id, "ai_api_key");
    return json({
      ai_provider: (await getSetting(env, user.id, "ai_provider")) || "openai",
      ai_model: (await getSetting(env, user.id, "ai_model")) || "gpt-4o-mini",
      ai_base_url:
        (await getSetting(env, user.id, "ai_base_url")) || "https://api.openai.com/v1",
      ai_api_key_set: !!key,
    });
  }
  if (path === "/settings/ai" && method === "PUT") {
    const body = (await req.json()) as Record<string, unknown>;
    if (body.ai_provider !== undefined || body.provider !== undefined) {
      await setSetting(
        env,
        user.id,
        "ai_provider",
        String(body.ai_provider ?? body.provider),
      );
    }
    if (body.ai_model !== undefined || body.model !== undefined) {
      await setSetting(env, user.id, "ai_model", String(body.ai_model ?? body.model));
    }
    if (body.ai_base_url !== undefined || body.base_url !== undefined) {
      await setSetting(
        env,
        user.id,
        "ai_base_url",
        String(body.ai_base_url ?? body.base_url),
      );
    }
    const keyVal = body.ai_api_key ?? body.api_key;
    if (keyVal !== undefined && keyVal !== null && keyVal !== "") {
      await setSetting(env, user.id, "ai_api_key", String(keyVal), true);
    }
    const key = await getSecretSetting(env, user.id, "ai_api_key");
    return json({
      ai_provider: (await getSetting(env, user.id, "ai_provider")) || "openai",
      ai_model: (await getSetting(env, user.id, "ai_model")) || "gpt-4o-mini",
      ai_base_url:
        (await getSetting(env, user.id, "ai_base_url")) || "https://api.openai.com/v1",
      ai_api_key_set: !!key,
    });
  }
  if (path === "/settings/ai/test" && method === "POST") {
    const key = await getSecretSetting(env, user.id, "ai_api_key");
    if (!key) return json({ ok: false, message: "AI API key not set" });
    try {
      const reply = await chatCompletion(env, user.id, [
        { role: "user", content: "Reply with the single word pong." },
      ]);
      return json({ ok: true, reply: reply.slice(0, 200), message: "ok" });
    } catch (e) {
      return json({
        ok: false,
        message: e instanceof Error ? e.message.slice(0, 300) : "provider error",
      });
    }
  }

  // AI extra endpoints
  if (path === "/ai/fetch-page-info" && method === "POST") {
    const body = (await req.json()) as { url?: string };
    if (!body.url) return err("validation", "url required");
    const target = body.url.includes("://") ? body.url : `https://${body.url}`;
    const safe = assertSafeUrl(target);
    if (!safe.ok) return err("ssrf", safe.reason, 400);
    try {
      const r = await safeFetch(target, { method: "GET", timeoutMs: 10_000, maxRedirects: 3 });
      const html = await r.text();
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const descMatch =
        html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) ||
        html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
      // Use request URL (manual redirects already validated each hop)
      return json({
        url: target,
        title: (titleMatch?.[1] || "").trim().slice(0, 500),
        description: (descMatch?.[1] || "").trim().slice(0, 2000),
        status_code: r.status,
      });
    } catch (e) {
      const code = (e as any)?.code === "ssrf" ? "ssrf" : "fetch_failed";
      return err(
        code,
        e instanceof Error ? e.message.slice(0, 300) : "fetch failed",
        400,
      );
    }
  }
  if (path === "/ai/classify" && method === "POST") {
    const body = (await req.json()) as any;
    const key = await getSecretSetting(env, user.id, "ai_api_key");
    if (!key) return err("ai_not_configured", "AI API key not set", 400);
    try {
      const content = await chatCompletion(env, user.id, [
        {
          role: "system",
          content:
            "Classify the bookmark into a short category name. Reply with only the category.",
        },
        {
          role: "user",
          content: `Title: ${body.title || ""}\nURL: ${body.url || ""}\nDescription: ${body.description || ""}`,
        },
      ]);
      return json({ category: content.slice(0, 120) || "General", title: body.title || "" });
    } catch (e) {
      return err(
        "ai_provider_error",
        e instanceof Error ? e.message.slice(0, 300) : "provider error",
        502,
      );
    }
  }
  if (path === "/ai/summarize" && method === "POST") {
    const body = (await req.json()) as any;
    const key = await getSecretSetting(env, user.id, "ai_api_key");
    if (!key) return err("ai_not_configured", "AI API key not set", 400);
    try {
      const content = await chatCompletion(env, user.id, [
        {
          role: "system",
          content: "Summarize the bookmark in 1-2 sentences.",
        },
        {
          role: "user",
          content: `Title: ${body.title || ""}\nURL: ${body.url || ""}\nDescription: ${body.description || ""}`,
        },
      ]);
      return json({ summary: content });
    } catch (e) {
      return err(
        "ai_provider_error",
        e instanceof Error ? e.message.slice(0, 300) : "provider error",
        502,
      );
    }
  }
  async function workerQuickAdd(body: any, opts: { withTitle?: boolean; withCategory?: boolean } = {}) {
    if (!user) return err("unauthorized", "Missing token", 401);
    if (!body.url) return err("validation", "url required");
    const uid = user.id;
    const id = uuid();
    const t = now();
    const inbox = await getSetting(env, uid, "inbox_folder_id");
    const folderId = body.folder_id || inbox;
    const folderErr = await assertLiveFolder(env, uid, folderId);
    if (folderErr) return folderErr;
    const norm = normalizeUrl(body.url);
    let title = body.title || body.url;
    let aiCategory: string | null = null;
    let aiSummary: string | null = null;
    if (opts.withTitle || opts.withCategory) {
      const key = await getSecretSetting(env, uid, "ai_api_key");
      if (key) {
        try {
          if (opts.withTitle && !body.title) {
            title = (
              await chatCompletion(env, uid, [
                {
                  role: "system",
                  content: "Suggest a short bookmark title. Reply with title only.",
                },
                { role: "user", content: body.url },
              ])
            )
              .trim()
              .slice(0, 200) || title;
          }
          if (opts.withCategory) {
            aiCategory = (
              await chatCompletion(env, uid, [
                {
                  role: "system",
                  content: "Classify into a short category. Reply with category only.",
                },
                { role: "user", content: `URL: ${body.url}\nTitle: ${title}` },
              ])
            )
              .trim()
              .slice(0, 120);
          }
        } catch {
          /* continue without AI */
        }
      }
    }
    await env.DB.prepare(
      `INSERT INTO bookmarks (id, user_id, folder_id, title, url, url_normalized, description, visibility, is_favorite, is_archived, sort_order, link_status, ai_summary, ai_category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'private', 0, 0, 0, 'unknown', ?, ?, ?, ?)`,
    )
      .bind(
        id,
        uid,
        folderId,
        title,
        body.url,
        norm,
        aiSummary,
        aiCategory,
        t,
        t,
      )
      .run();
    await syncFts(env, { id, title, url: body.url, description: null });
    await writeOp(env, uid, "bookmark", id, "create", { id, url: body.url, ai_category: aiCategory });
    return json({
      id,
      title,
      url: body.url,
      folder_id: folderId,
      ai_category: aiCategory,
    });
  }
  if (path === "/ai/quick-add" && method === "POST") {
    return workerQuickAdd(await req.json());
  }
  // Canonical FastAPI-compatible paths (F003); keep hyphen aliases for compatibility
  if (
    (path === "/ai/quick-add/with-title" || path === "/ai/quick-add-with-title") &&
    method === "POST"
  ) {
    return workerQuickAdd(await req.json(), { withTitle: true });
  }
  if (
    (path === "/ai/quick-add/with-category" || path === "/ai/quick-add-with-category") &&
    method === "POST"
  ) {
    return workerQuickAdd(await req.json(), { withTitle: true, withCategory: true });
  }
  if (path === "/ai/batch" && method === "POST") {
    const body = (await req.json()) as { bookmark_ids?: string[]; actions?: string[] };
    const ids = body.bookmark_ids || [];
    const actions = body.actions || ["summarize"];
    await ensureAiTasksTable(env);
    const taskId = uuid();
    const t0 = now();
    await env.DB.prepare(
      `INSERT INTO ai_tasks (id, user_id, kind, status, progress, payload, result, error, created_at, finished_at)
       VALUES (?, ?, 'batch', 'running', 0, ?, '{}', NULL, ?, NULL)`,
    )
      .bind(taskId, user.id, JSON.stringify({ bookmark_ids: ids, actions }), t0)
      .run();
    // Workers: bounded synchronous batch; persist result so /ai/tasks/{id} works (F011)
    const results: any[] = [];
    for (const bid of ids.slice(0, 20)) {
      const b = await env.DB.prepare(
        "SELECT * FROM bookmarks WHERE id=? AND user_id=? AND deleted_at IS NULL",
      )
        .bind(bid, user.id)
        .first<any>();
      if (!b) {
        results.push({ id: bid, ok: false, error: "not_found" });
        continue;
      }
      const patch: Record<string, string> = {};
      try {
        if (actions.includes("summarize")) {
          const key = await getSecretSetting(env, user.id, "ai_api_key");
          if (!key) {
            results.push({ id: bid, ok: false, error: "ai_not_configured" });
            continue;
          }
          patch.ai_summary = await chatCompletion(env, user.id, [
            { role: "system", content: "Summarize the bookmark in 1-2 sentences." },
            {
              role: "user",
              content: `Title: ${b.title}\nURL: ${b.url}\nDescription: ${b.description || ""}`,
            },
          ]);
        }
        if (actions.includes("classify")) {
          patch.ai_category = (
            await chatCompletion(env, user.id, [
              {
                role: "system",
                content: "Classify into a short category. Reply with category only.",
              },
              { role: "user", content: `Title: ${b.title}\nURL: ${b.url}` },
            ])
          ).slice(0, 120);
        }
        if (Object.keys(patch).length) {
          await env.DB.prepare(
            "UPDATE bookmarks SET ai_summary=COALESCE(?, ai_summary), ai_category=COALESCE(?, ai_category), updated_at=? WHERE id=?",
          )
            .bind(patch.ai_summary ?? null, patch.ai_category ?? null, now(), bid)
            .run();
          await writeOp(env, user.id, "bookmark", bid, "update", patch);
        }
        results.push({ id: bid, ok: true, ...patch });
      } catch (e) {
        results.push({
          id: bid,
          ok: false,
          error: e instanceof Error ? e.message.slice(0, 200) : "error",
        });
      }
    }
    const t1 = now();
    const resultPayload = { items: results, results };
    await env.DB.prepare(
      "UPDATE ai_tasks SET status=?, progress=1, result=?, finished_at=? WHERE id=?",
    )
      .bind("done", JSON.stringify(resultPayload), t1, taskId)
      .run();
    return json({
      id: taskId,
      status: "done",
      progress: 1,
      result: resultPayload,
      results,
    });
  }
  if (path === "/ai/tasks" && method === "GET") {
    await ensureAiTasksTable(env);
    const rows = (
      await env.DB.prepare(
        "SELECT id, kind, status, progress, created_at, finished_at FROM ai_tasks WHERE user_id=? ORDER BY created_at DESC LIMIT 50",
      )
        .bind(user.id)
        .all<any>()
    ).results;
    return json({ items: rows });
  }
  if (path.startsWith("/ai/tasks/") && method === "GET") {
    await ensureAiTasksTable(env);
    const taskId = path.slice("/ai/tasks/".length);
    if (taskId.includes("/")) return err("not_found", `No route ${method} ${path}`, 404);
    const row = await env.DB.prepare(
      "SELECT * FROM ai_tasks WHERE id=? AND user_id=?",
    )
      .bind(taskId, user.id)
      .first<any>();
    if (!row) return err("not_found", "Task not found", 404);
    let result: unknown = {};
    try {
      result = JSON.parse(row.result || "{}");
    } catch {
      result = {};
    }
    return json({
      id: row.id,
      status: row.status,
      progress: row.progress,
      result,
      error: row.error,
      kind: row.kind,
    });
  }
  if (path === "/mcp/tools" && method === "GET") {
    return json({
      tools: MCP_TOOL_NAMES.map((name) => ({
        name,
        description: `MarkHub MCP tool: ${name}`,
      })),
    });
  }
  if (path === "/mcp/call" && method === "POST") {
    // REST compatibility endpoint shared with FastAPI (F010) — return tool result body
    const body = (await req.json()) as { name?: string; arguments?: Record<string, unknown> };
    if (!body.name) return err("validation", "name is required");
    try {
      const result = await dispatchMcpTool(env, user, body.name, body.arguments || {});
      return json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = /not found/i.test(msg) ? 404 : 400;
      return err(status === 404 ? "not_found" : "mcp_error", msg, status);
    }
  }

  // WebDAV config
  if (path === "/backup/webdav" && method === "GET") {
    const raw = await getSetting(env, user.id, "webdav_config");
    let cfg: any = {};
    try {
      cfg = raw ? JSON.parse(raw) : {};
    } catch {
      cfg = {};
    }
    const pw = await getSetting(env, user.id, "webdav_password");
    if (url.searchParams.get("test") === "true") {
      if (!cfg.url) {
        return json({ ok: false, code: "webdav_config", message: "url required" });
      }
      const password = await getSecretSetting(env, user.id, "webdav_password");
      const t0 = Date.now();
      try {
        const base = String(cfg.url).replace(/\/$/, "");
        const auth =
          cfg.username || password
            ? "Basic " + btoa(`${cfg.username || ""}:${password || ""}`)
            : "";
        const r = await fetch(base + "/", {
          method: "PROPFIND",
          headers: {
            Depth: "0",
            ...(auth ? { Authorization: auth } : {}),
          },
        });
        if (!r.ok && r.status !== 207) {
          return json({
            ok: false,
            code: "webdav_error",
            message: `HTTP ${r.status}`,
            latency_ms: Date.now() - t0,
          });
        }
        return json({
          ok: true,
          latency_ms: Date.now() - t0,
          endpoint_reachable: true,
        });
      } catch (e) {
        return json({
          ok: false,
          code: "webdav_network",
          message: e instanceof Error ? e.message.slice(0, 200) : "network error",
          latency_ms: Date.now() - t0,
        });
      }
    }
    return json({
      enabled: !!cfg.enabled,
      url: cfg.url || "",
      username: cfg.username || "",
      password_set: !!pw,
      path: cfg.path || "markhub-backup/",
      keep_backups: cfg.keep_backups || 7,
      backup_time: cfg.backup_time || "02:00",
      last_backup_at: cfg.last_backup_at || null,
    });
  }
  if (path === "/backup/webdav" && method === "PUT") {
    const body = (await req.json()) as any;
    const prev = await getSetting(env, user.id, "webdav_config");
    let cfg: any = {};
    try {
      cfg = prev ? JSON.parse(prev) : {};
    } catch {
      cfg = {};
    }
    for (const k of ["enabled", "url", "username", "path", "keep_backups", "backup_time"]) {
      if (body[k] !== undefined) cfg[k] = body[k];
    }
    if (body.password)
      await setSetting(env, user.id, "webdav_password", String(body.password), true);
    await setSetting(env, user.id, "webdav_config", JSON.stringify(cfg));
    return handleApi(
      new Request(req.url, { method: "GET", headers: req.headers }),
      env,
      "/backup/webdav",
    );
  }
  if (path === "/backup/webdav" && method === "POST") {
    const result = await runWebdavBackup(env, user.id);
    if (!result.ok) {
      metrics.backup_webdav_fail++;
      logError("backup_webdav_failed", { code: result.code, message: result.message });
      return err(result.code, result.message, 400);
    }
    metrics.backup_webdav_ok++;
    logInfo("backup_webdav_ok", { path: result.path });
    return json(result);
  }

  // CSV/HTML/JSON export — lossless native schema shared with scheduled backups (RQG-BACKUP-001)
  if (path === "/backup/export" && method === "GET") {
    const format = url.searchParams.get("format") || "json";
    if (!new Set(["json", "csv", "html"]).has(format)) {
      return err("validation", `Unsupported export format: ${format}`);
    }
    const payload = await exportJsonPayload(env, user.id);
    const folders = payload.folders as any[];
    const enriched = payload.bookmarks as any[];
    const folderById = new Map(folders.map((f) => [f.id, f]));
    if (format === "csv") {
      const lines = [
        `# markhub-metadata:${portableBackupMetadata(
          { folders: payload.folders, tags: payload.tags },
          enriched,
        )}`,
        "title,url,description,folder,folder_path,folder_visibility,tags,visibility,is_favorite,is_archived,sort_order",
      ];
      for (const b of enriched) {
        const segs: string[] = Array.isArray(b.folder_path) ? b.folder_path : [];
        const folderName = segs.length
          ? segs.join(" > ")
          : folderById.get(b.folder_id)?.name || "";
        const folderVis = segs.length
          ? folderById.get(b.folder_id)?.visibility || "private"
          : "";
        const tagStr = Array.isArray(b.tags)
          ? b.tags.map((t: any) => (typeof t === "string" ? t : t.name)).join(",")
          : "";
        const pathJson = JSON.stringify(segs).replace(/"/g, '""');
        lines.push(
          [
            `"${(b.title || "").replace(/"/g, '""')}"`,
            `"${(b.url || "").replace(/"/g, '""')}"`,
            `"${(b.description || "").replace(/"/g, '""')}"`,
            `"${String(folderName).replace(/"/g, '""')}"`,
            `"${pathJson}"`,
            folderVis,
            `"${tagStr.replace(/"/g, '""')}"`,
            b.visibility,
            b.is_favorite ? "true" : "false",
            b.is_archived ? "true" : "false",
            String(b.sort_order ?? 0),
          ].join(","),
        );
      }
      return new Response(lines.join("\n"), { headers: { "Content-Type": "text/csv" } });
    }
    if (format === "html") {
      const byParent = new Map<string | null, any[]>();
      for (const f of folders) {
        const p = f.parent_id ?? null;
        const list = byParent.get(p) || [];
        list.push(f);
        byParent.set(p, list);
      }
      const byFolder = new Map<string, any[]>();
      for (const b of enriched) {
        const list = byFolder.get(b.folder_id) || [];
        list.push(b);
        byFolder.set(b.folder_id, list);
      }
      const lines: string[] = [
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
        "<TITLE>MarkHub Bookmarks</TITLE>",
        "<H1>MarkHub Bookmarks</H1>",
        "<DL><p>",
      ];
      const exportedBookmarks: Array<Record<string, unknown>> = [];
      const walk = (parentId: string | null, indent: number) => {
        const pad = "    ".repeat(indent);
        for (const f of (byParent.get(parentId) || []).sort(
          (a, b) => (a.sort_order || 0) - (b.sort_order || 0),
        )) {
          if (f.is_system) {
            for (const b of (byFolder.get(f.id) || []).sort(
              (a, b) => (a.sort_order || 0) - (b.sort_order || 0),
            )) {
              exportedBookmarks.push(b);
              const tags = Array.isArray(b.tags)
                ? b.tags
                    .map((t: any) => (typeof t === "string" ? t : t.name))
                    .filter(Boolean)
                    .join(",")
                : "";
              const attrs = [
                `HREF="${safeHref(b.url)}"`,
                `DATA-VISIBILITY="${escapeHtml(String(b.visibility || "private"))}"`,
                `DATA-FAVORITE="${b.is_favorite ? "true" : "false"}"`,
                `DATA-ARCHIVED="${b.is_archived ? "true" : "false"}"`,
                `DATA-SORT-ORDER="${b.sort_order ?? 0}"`,
              ];
              if (tags) attrs.push(`TAGS="${escapeHtml(tags)}"`);
              lines.push(
                `${pad}<DT><A ${attrs.join(" ")}>${escapeHtml(b.title || b.url)}</A>`,
              );
            }
            walk(f.id, indent);
            continue;
          }
          lines.push(
            `${pad}<DT><H3 DATA-VISIBILITY="${escapeHtml(String(f.visibility || "private"))}" DATA-SORT-ORDER="${f.sort_order ?? 0}">${escapeHtml(f.name)}</H3>`,
          );
          lines.push(`${pad}<DL><p>`);
          for (const b of (byFolder.get(f.id) || []).sort(
            (a, b) => (a.sort_order || 0) - (b.sort_order || 0),
          )) {
            exportedBookmarks.push(b);
            const tags = Array.isArray(b.tags)
              ? b.tags
                  .map((t: any) => (typeof t === "string" ? t : t.name))
                  .filter(Boolean)
                  .join(",")
              : "";
            const attrs = [
              `HREF="${safeHref(b.url)}"`,
              `DATA-VISIBILITY="${escapeHtml(String(b.visibility || "private"))}"`,
              `DATA-FAVORITE="${b.is_favorite ? "true" : "false"}"`,
              `DATA-ARCHIVED="${b.is_archived ? "true" : "false"}"`,
              `DATA-SORT-ORDER="${b.sort_order ?? 0}"`,
            ];
            if (tags) attrs.push(`TAGS="${escapeHtml(tags)}"`);
            lines.push(
              `${pad}    <DT><A ${attrs.join(" ")}>${escapeHtml(b.title || b.url)}</A>`,
            );
          }
          walk(f.id, indent + 1);
          lines.push(`${pad}</DL><p>`);
        }
      };
      walk(null, 1);
      lines.push("</DL><p>");
      lines.splice(
        2,
        0,
        `<META NAME="markhub-metadata" CONTENT="${portableBackupMetadata(
          { folders: payload.folders, tags: payload.tags },
          exportedBookmarks,
        )}">`,
      );
      return new Response(lines.join("\n"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return json(payload);
  }

  // Board annotation patch / groups / import
  if (path.match(/^\/boards\/[^/]+\/annotations\/[^/]+$/) && method === "PATCH") {
    const parts = path.split("/");
    const boardId = parts[2]!;
    const aid = parts[4]!;
    const body = (await req.json()) as any;
    const row = await env.DB.prepare("SELECT * FROM annotations WHERE id=? AND board_id=?")
      .bind(aid, boardId)
      .first<any>();
    if (!row) return err("not_found", "Annotation not found", 404);
    const tAnn = now();
    await env.DB.prepare(
      "UPDATE annotations SET status=COALESCE(?, status), risk=COALESCE(?, risk), price_tag=COALESCE(?, price_tag), note=COALESCE(?, note), group_id=COALESCE(?, group_id), annotation_updated_at=? WHERE id=?",
    )
      .bind(
        body.status ?? null,
        body.risk ?? null,
        body.price_tag ?? null,
        body.note ?? null,
        body.group_id ?? null,
        tAnn,
        aid,
      )
      .run();
    await writeOp(env, user.id, "annotation", aid, "update", {
      id: aid,
      board_id: boardId,
      ...body,
    });
    return json(serializeAnnotationRow({ ...row, ...body, annotation_updated_at: tAnn }));
  }
  if (path.match(/^\/boards\/[^/]+\/groups$/) && method === "GET") {
    const boardId = path.split("/")[2]!;
    const rows = (
      await env.DB.prepare("SELECT * FROM board_groups WHERE board_id=? ORDER BY sort_order")
        .bind(boardId)
        .all()
    ).results;
    return json({ items: rows });
  }
  if (path.match(/^\/boards\/[^/]+\/groups$/) && method === "POST") {
    const boardId = path.split("/")[2]!;
    const owned = await env.DB.prepare("SELECT id FROM boards WHERE id = ? AND user_id = ?")
      .bind(boardId, user.id)
      .first();
    if (!owned) return err("not_found", "Board not found", 404);
    const body = (await req.json()) as any;
    const id = uuid();
    await env.DB.prepare(
      "INSERT INTO board_groups (id, board_id, name, color, keywords, sort_order, collapsed) VALUES (?, ?, ?, ?, ?, 0, 0)",
    )
      .bind(id, boardId, body.name || "Group", body.color || null, JSON.stringify(body.keywords || []))
      .run();
    await writeOp(env, user.id, "board_group", id, "create", {
      id,
      board_id: boardId,
      name: body.name || "Group",
    });
    return json({ id, board_id: boardId, name: body.name || "Group" });
  }
  if (path.match(/^\/boards\/[^/]+\/groups\/reorder$/) && method === "POST") {
    const boardId = path.split("/")[2]!;
    const owned = await env.DB.prepare("SELECT id FROM boards WHERE id = ? AND user_id = ?")
      .bind(boardId, user.id)
      .first();
    if (!owned) return err("not_found", "Board not found", 404);
    const body = (await req.json()) as { ordered_ids?: string[] };
    let i = 0;
    for (const gid of body.ordered_ids || []) {
      await env.DB.prepare(
        "UPDATE board_groups SET sort_order = ? WHERE id = ? AND board_id = ?",
      )
        .bind(i, gid, boardId)
        .run();
      i++;
    }
    await writeOp(env, user.id, "reorder", boardId, "reorder", {
      scope: "board_group",
      ordered_ids: body.ordered_ids || [],
    });
    return json({ ok: true, ordered_ids: body.ordered_ids || [] });
  }
  if (path.match(/^\/boards\/[^/]+\/import$/) && method === "POST") {
    const boardId = path.split("/")[2]!;
    const body = (await req.json()) as any;
    const data = body.data || body || {};
    const groups = data.groups || [];
    let groups_created = 0;
    for (const g of groups) {
      const id = uuid();
      try {
        await env.DB.prepare(
          "INSERT INTO board_groups (id, board_id, name, color, keywords, sort_order, collapsed) VALUES (?, ?, ?, ?, ?, 0, 0)",
        )
          .bind(
            id,
            boardId,
            g.name || "Group",
            g.color || null,
            JSON.stringify(g.keywords || []),
          )
          .run();
        groups_created++;
      } catch {
        /* ignore */
      }
    }
    const anns = data.annotations || data.channels || [];
    let annotations_created = 0;
    let annotations_updated = 0;
    let unmatched = 0;
    for (const a of anns) {
      if (!a || typeof a !== "object") continue;
      let bm: any = null;
      if (a.bookmark_id) {
        bm = await env.DB.prepare(
          "SELECT * FROM bookmarks WHERE id=? AND user_id=? AND deleted_at IS NULL",
        )
          .bind(a.bookmark_id, user.id)
          .first();
      }
      if (!bm && (a.url || a.href || a.link)) {
        const norm = normalizeUrl(String(a.url || a.href || a.link));
        bm = await env.DB.prepare(
          "SELECT * FROM bookmarks WHERE user_id=? AND url_normalized=? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1",
        )
          .bind(user.id, norm)
          .first();
      }
      if (!bm) {
        unmatched++;
        continue;
      }
      const existing = await env.DB.prepare(
        "SELECT * FROM annotations WHERE board_id=? AND bookmark_id=?",
      )
        .bind(boardId, bm.id)
        .first<any>();
      const t = now();
      if (existing) {
        await env.DB.prepare(
          "UPDATE annotations SET status=?, note=?, present=1, annotation_updated_at=? WHERE id=?",
        )
          .bind(a.status || existing.status || "pending", a.note || a.remark || existing.note, t, existing.id)
          .run();
        await writeOp(env, user.id, "annotation", existing.id, "update", {
          from: "board_import",
          bookmark_id: bm.id,
        });
        annotations_updated++;
      } else {
        const aid = uuid();
        await env.DB.prepare(
          `INSERT INTO annotations (id, board_id, bookmark_id, status, risk, price_tag, secondary_group_ids, source_folder_id, present, first_seen_at, last_seen_at, annotation_updated_at, fields)
           VALUES (?, ?, ?, ?, '', '', '[]', ?, 1, ?, ?, ?, '{}')`,
        )
          .bind(aid, boardId, bm.id, a.status || "pending", bm.folder_id, t, t, t)
          .run();
        await writeOp(env, user.id, "annotation", aid, "create", {
          from: "board_import",
          bookmark_id: bm.id,
        });
        annotations_created++;
      }
    }
    await writeOp(env, user.id, "board", boardId, "import", {
      groups_created,
      annotations_created,
      annotations_updated,
      unmatched,
    });
    return json({
      ok: true,
      board_id: boardId,
      groups_created,
      annotations_created,
      annotations_updated,
      unmatched,
    });
  }

  // MCP settings
  if (path === "/settings/mcp" && method === "GET") {
    const enabled = (await getSetting(env, user.id, "mcp_enabled")) === "true";
    const hash = await getSetting(env, user.id, "mcp_token_hash");
    const origins = await getSetting(env, user.id, "mcp_allowed_origins");
    return json({
      enabled,
      token_set: !!hash,
      allowed_origins: origins || "",
    });
  }
  if (path === "/settings/mcp" && method === "PUT") {
    const body = (await req.json()) as any;
    if (body.enabled !== undefined) {
      await setSetting(env, user.id, "mcp_enabled", body.enabled ? "true" : "false");
    }
    if (body.allowed_origins !== undefined) {
      await setSetting(env, user.id, "mcp_allowed_origins", String(body.allowed_origins));
    }
    if (body.token) {
      const th = await sha256Hex(String(body.token));
      await setSetting(env, user.id, "mcp_token_hash", th, true);
    }
    return handleApi(
      new Request(req.url, { method: "GET", headers: req.headers }),
      env,
      "/settings/mcp",
    );
  }
  if (path === "/settings/mcp/token" && method === "POST") {
    const token = b64url(crypto.getRandomValues(new Uint8Array(24)));
    const th = await sha256Hex(token);
    await setSetting(env, user.id, "mcp_token_hash", th, true);
    await setSetting(env, user.id, "mcp_enabled", "true");
    return json({ token, enabled: true });
  }

  return err("not_found", `No route ${method} ${path}`, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const started = Date.now();
    metrics.requests++;
    await enableForeignKeys(env);
    if (url.pathname.startsWith("/api/v1")) {
      const path = url.pathname.slice("/api/v1".length) || "/";
      try {
        const res = await handleApi(req, env, path);
        if (res.status >= 500) metrics.errors_5xx++;
        else if (res.status >= 400) metrics.errors_4xx++;
        logInfo("request", {
          method: req.method,
          path,
          status: res.status,
          latency_ms: Date.now() - started,
        });
        return res;
      } catch (e) {
        metrics.errors_5xx++;
        logError("request_error", {
          method: req.method,
          path,
          message: e instanceof Error ? e.message : String(e),
          latency_ms: Date.now() - started,
        });
        return err("internal", e instanceof Error ? e.message : "error", 500);
      }
    }
    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(req);
      if (asset.status !== 404) return asset;
      if (req.method === "GET" && !url.pathname.includes(".")) {
        return env.ASSETS.fetch(new Request(new URL("/index.html", req.url), req));
      }
      return asset;
    }
    return json({ name: "MarkHub Worker", version: VERSION, api: "/api/v1" });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    logInfo("cron_start", {});
    await enableForeignKeys(env);
    await ensureBootstrap(env);
    // F005: 30-day soft-delete garbage collection
    try {
      const gc = await runSoftDeleteGc(env);
      logInfo("cron_gc", gc);
    } catch (e) {
      logWarn("cron_gc_error", { message: e instanceof Error ? e.message : String(e) });
    }
    const users = (await env.DB.prepare("SELECT id FROM users").all<{ id: string }>()).results;
    for (const u of users) {
      // Board incremental scans
      const boards = (
        await env.DB.prepare("SELECT id FROM boards WHERE user_id = ?").bind(u.id).all<{ id: string }>()
      ).results;
      for (const b of boards) {
        try {
          await runBoardScan(env, u.id, b.id, "incremental");
          metrics.board_scan_ok++;
        } catch (e) {
          metrics.board_scan_fail++;
          logWarn("board_scan_fail", {
            board_id: b.id,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // WebDAV scheduled backup (Asia/Shanghai backup_time)
      try {
        const raw = await getSetting(env, u.id, "webdav_config");
        const cfg = raw ? JSON.parse(raw) : {};
        if (cfg.enabled && shouldRunBackup(cfg.backup_time || "02:00", cfg.last_backup_at)) {
          const r = await runWebdavBackup(env, u.id);
          if (r.ok) {
            metrics.backup_webdav_ok++;
            logInfo("cron_webdav_ok", { path: r.path });
          } else {
            metrics.backup_webdav_fail++;
            logWarn("cron_webdav_fail", { code: r.code, message: r.message });
          }
        }
      } catch (e) {
        metrics.backup_webdav_fail++;
        logWarn("cron_webdav_error", { message: e instanceof Error ? e.message : String(e) });
      }

      // S3 scheduled backup
      try {
        const raw = await getSetting(env, u.id, "s3_config");
        const cfg = raw ? JSON.parse(raw) : {};
        if (cfg.enabled && shouldRunBackup(cfg.backup_time || "02:00", cfg.last_backup_at)) {
          const r = await runS3Backup(env, u.id);
          if (r.ok) {
            metrics.backup_s3_ok++;
            logInfo("cron_s3_ok", { key: r.key });
          } else {
            metrics.backup_s3_fail++;
            logWarn("cron_s3_fail", { code: r.code, message: r.message });
          }
        }
      } catch (e) {
        metrics.backup_s3_fail++;
        logWarn("cron_s3_error", { message: e instanceof Error ? e.message : String(e) });
      }
    }
    logInfo("cron_done", { metrics: snapshotMetrics() });
  },
};
