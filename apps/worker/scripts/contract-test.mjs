/**
 * Worker-runtime contract tests (R3-F011).
 * Applies D1 migrations, starts no server — expects WORKER_BASE_URL or uses
 * wrangler-less in-process miniflare when MARKHUB_WORKER_BASE is set.
 *
 * Usage:
 *   MARKHUB_WORKER_BASE=http://127.0.0.1:18787 \
 *   MARKHUB_ADMIN_PASSWORD=WorkerPass12345 \
 *   node apps/worker/scripts/contract-test.mjs
 */

const BASE = (process.env.MARKHUB_WORKER_BASE || "").replace(/\/$/, "");
const USER = process.env.MARKHUB_ADMIN_USERNAME || "admin";
const PASS = process.env.MARKHUB_ADMIN_PASSWORD || "WorkerPass12345";
const NEW_PASS = process.env.MARKHUB_NEW_PASSWORD || "WorkerPassChanged99";

if (!BASE) {
  console.error("MARKHUB_WORKER_BASE required");
  process.exit(2);
}

let failed = 0;
const results = [];

async function req(method, path, { token, body, headers } = {}) {
  const h = { ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: r.status, text, json, headers: r.headers };
}

function assert(id, cond, detail) {
  results.push({ id, ok: !!cond, detail: detail || "" });
  if (!cond) {
    failed++;
    console.error(`FAIL ${id}: ${detail}`);
  } else {
    console.log(`ok   ${id}`);
  }
}

async function main() {
  // health
  let r = await req("GET", "/api/v1/health");
  assert("health", r.status === 200 && r.json?.status, `status=${r.status}`);

  // login + force password change
  r = await req("POST", "/api/v1/auth/login", {
    body: { username: USER, password: PASS },
  });
  if (r.status !== 200) {
    // maybe already changed
    r = await req("POST", "/api/v1/auth/login", {
      body: { username: USER, password: NEW_PASS },
    });
  }
  assert("login", r.status === 200 && r.json?.access_token, r.text.slice(0, 200));
  let token = r.json?.access_token;
  if (r.json?.must_change_password) {
    const cur = r.json?.must_change_password ? PASS : NEW_PASS;
    // try both
    let ch = await req("PUT", "/api/v1/auth/credentials", {
      token,
      body: { current_password: PASS, new_password: NEW_PASS },
    });
    if (ch.status !== 200) {
      ch = await req("PUT", "/api/v1/auth/credentials", {
        token,
        body: { current_password: NEW_PASS, new_password: NEW_PASS },
      });
    }
    assert("force_change", ch.status === 200, ch.text.slice(0, 200));
    r = await req("POST", "/api/v1/auth/login", {
      body: { username: USER, password: NEW_PASS },
    });
    token = r.json?.access_token;
  }

  // folder + bookmark CRUD
  r = await req("POST", "/api/v1/folders", {
    token,
    body: { name: "Contract Folder", visibility: "public" },
  });
  assert("folder_create", r.status === 200 && r.json?.id, r.text.slice(0, 200));
  const folderId = r.json?.id;

  r = await req("POST", "/api/v1/bookmarks", {
    token,
    body: {
      title: "Example",
      url: "https://example.com/contract",
      folder_id: folderId,
      visibility: "public",
      is_favorite: true,
      tags: ["contract"],
    },
  });
  assert("bookmark_create", r.status === 200 && r.json?.id && r.json?.is_favorite === true, r.text.slice(0, 200));
  const bmId = r.json?.id;

  r = await req("GET", `/api/v1/bookmarks/${bmId}`, { token });
  assert("bookmark_get", r.status === 200 && r.json?.id === bmId, r.text.slice(0, 200));

  // batch move via nested payload
  const f2 = await req("POST", "/api/v1/folders", {
    token,
    body: { name: "Batch Target" },
  });
  const targetFolder = f2.json?.id;
  r = await req("POST", "/api/v1/bookmarks/batch", {
    token,
    body: { action: "move", ids: [bmId], payload: { folder_id: targetFolder } },
  });
  assert(
    "bookmark_batch_move",
    r.status === 200 && (r.json?.affected === 1 || r.json?.count === 1),
    r.text.slice(0, 200),
  );
  r = await req("GET", `/api/v1/bookmarks/${bmId}`, { token });
  assert("bookmark_batch_persisted", r.json?.folder_id === targetFolder, JSON.stringify(r.json));

  // reorder + clock
  r = await req("POST", "/api/v1/bookmarks/reorder", {
    token,
    body: { folder_id: targetFolder, ordered_ids: [bmId] },
  });
  assert("bookmark_reorder", r.status === 200, r.text.slice(0, 200));

  // folder delete mode validation
  const bad = await req("DELETE", `/api/v1/folders/${folderId}?mode=typo_mode`, { token });
  assert(
    "folder_delete_enum",
    bad.status === 400 || bad.status === 422,
    `status=${bad.status} ${bad.text.slice(0, 120)}`,
  );

  // CSV import (unique URL per run)
  const stamp = Date.now();
  r = await req("POST", "/api/v1/backup/import", {
    token,
    body: {
      format: "csv",
      strategy: "skip_duplicate",
      content: `title,url\nCSV Item,https://csv.example/item-${stamp}\n`,
    },
  });
  assert("import_csv", r.status === 200 && (r.json?.created ?? 0) >= 1, r.text.slice(0, 200));

  // HTML import
  r = await req("POST", "/api/v1/backup/import", {
    token,
    body: {
      format: "html",
      strategy: "skip_duplicate",
      content: `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n<DT><A HREF="https://html.example/a-${stamp}">HTML A</A>\n</DL><p>`,
    },
  });
  assert("import_html", r.status === 200 && (r.json?.created ?? 0) >= 1, r.text.slice(0, 200));

  // backup s3 GET test without config
  r = await req("GET", "/api/v1/backup/s3?test=true", { token });
  assert("s3_test_route", r.status === 200 && r.json && "ok" in r.json, r.text.slice(0, 160));

  // webdav POST route exists (may fail config)
  r = await req("POST", "/api/v1/backup/webdav", { token });
  assert(
    "webdav_post_route",
    r.status === 400 || r.status === 200,
    `status=${r.status} ${r.text.slice(0, 120)}`,
  );
  r = await req("POST", "/api/v1/backup/s3", { token });
  assert(
    "s3_post_route",
    r.status === 400 || r.status === 200,
    `status=${r.status} ${r.text.slice(0, 120)}`,
  );

  // metrics — shared OpenAPI field requests_total (RQG-CONTRACT-001)
  r = await req("GET", "/api/v1/metrics");
  assert(
    "metrics_requests_total",
    r.status === 200 &&
      typeof r.json?.requests_total === "number" &&
      r.json.requests_total > 0,
    r.text.slice(0, 160),
  );

  // Invalid folder_id rejected on REST write paths (RQG-CF-DATA-001)
  r = await req("POST", "/api/v1/bookmarks", {
    token,
    body: {
      title: "Orphan",
      url: `https://orphan.example/${Date.now()}`,
      folder_id: "00000000-0000-4000-8000-000000000099",
    },
  });
  assert(
    "bookmark_invalid_folder",
    r.status === 400 || r.status === 404 || r.status === 422,
    `status=${r.status} ${r.text.slice(0, 160)}`,
  );
  r = await req("PATCH", `/api/v1/bookmarks/${bmId}`, {
    token,
    body: { folder_id: "00000000-0000-4000-8000-000000000099" },
  });
  assert(
    "bookmark_patch_invalid_folder",
    r.status === 400 || r.status === 404 || r.status === 422,
    `status=${r.status} ${r.text.slice(0, 160)}`,
  );
  r = await req("POST", "/api/v1/bookmarks/batch", {
    token,
    body: {
      action: "move",
      ids: [bmId],
      payload: { folder_id: "00000000-0000-4000-8000-000000000099" },
    },
  });
  assert(
    "bookmark_batch_invalid_folder",
    r.status === 400 || r.status === 404 || r.status === 422,
    `status=${r.status} ${r.text.slice(0, 160)}`,
  );

  // Native backup round-trip preserves favorite/archive + folder path (RQG-BACKUP-001)
  // Run last: replace_all soft-deletes prior fixtures.
  r = await req("POST", "/api/v1/folders", {
    token,
    body: { name: `R7Nest-${stamp}` },
  });
  const nestFolder = r.json?.id;
  r = await req("POST", "/api/v1/bookmarks", {
    token,
    body: {
      title: "R7 Fav",
      url: `https://r7-fav.example/${stamp}`,
      folder_id: nestFolder,
      is_favorite: true,
      is_archived: true,
      tags: ["r7-round"],
      visibility: "unlisted",
    },
  });
  assert("r7_seed", r.status === 200 && r.json?.is_favorite === true, r.text.slice(0, 160));
  r = await req("GET", "/api/v1/backup/export?format=json", { token });
  assert(
    "export_has_folder_path",
    r.status === 200 &&
      Array.isArray(r.json?.bookmarks) &&
      r.json.bookmarks.some(
        (b) =>
          b.url?.includes("r7-fav") &&
          Array.isArray(b.folder_path) &&
          b.folder_path.some((p) => String(p).includes("R7Nest")) &&
          (b.is_favorite === true || b.is_favorite === 1),
      ),
    r.text.slice(0, 240),
  );
  const exportBody = r.json;
  r = await req("POST", "/api/v1/backup/import", {
    token,
    body: {
      content: JSON.stringify(exportBody),
      format: "json",
      strategy: "replace_all",
      confirm_replace: true,
    },
  });
  assert("import_replace_all", r.status === 200 && (r.json?.created ?? 0) >= 1, r.text.slice(0, 200));
  r = await req("GET", `/api/v1/bookmarks?q=r7-fav`, { token });
  const restored = (r.json?.items || []).find((b) => b.url?.includes("r7-fav"));
  assert(
    "restore_favorite_archive",
    restored &&
      restored.is_favorite === true &&
      restored.is_archived === true,
    JSON.stringify(restored || r.json).slice(0, 240),
  );

  // RQG-BACKUP-001: separator-containing folder names + empty folders survive restore.
  // Failure mode: `A/B` was reconstructed as A → B via slash-split path keys.
  r = await req("POST", "/api/v1/folders", {
    token,
    body: { name: "A/B", visibility: "public" },
  });
  assert("sep_parent_create", r.status === 200 && r.json?.name === "A/B", r.text.slice(0, 160));
  const sepParent = r.json?.id;
  r = await req("POST", "/api/v1/folders", {
    token,
    body: { name: "C", parent_id: sepParent, visibility: "private" },
  });
  assert("sep_child_create", r.status === 200 && r.json?.name === "C", r.text.slice(0, 160));
  const sepChild = r.json?.id;
  r = await req("POST", "/api/v1/folders", {
    token,
    body: { name: "Empty/Leaf", visibility: "unlisted" },
  });
  assert("sep_empty_create", r.status === 200 && r.json?.name === "Empty/Leaf", r.text.slice(0, 160));
  r = await req("POST", "/api/v1/bookmarks", {
    token,
    body: {
      title: "Sep BM",
      url: `https://r7-sep.example/${stamp}`,
      folder_id: sepChild,
      visibility: "public",
    },
  });
  assert("sep_bm_create", r.status === 200, r.text.slice(0, 160));
  r = await req("GET", "/api/v1/backup/export?format=json", { token });
  const sepExport = r.json;
  const sepHit = (sepExport?.bookmarks || []).find((b) => b.url?.includes("r7-sep"));
  assert(
    "export_sep_folder_path",
    r.status === 200 &&
      sepHit &&
      Array.isArray(sepHit.folder_path) &&
      sepHit.folder_path.length === 2 &&
      sepHit.folder_path[0] === "A/B" &&
      sepHit.folder_path[1] === "C",
    JSON.stringify(sepHit?.folder_path || r.text.slice(0, 200)),
  );
  assert(
    "export_empty_sep_folder",
    (sepExport?.folders || []).some((f) => f.name === "Empty/Leaf" && !f.is_system),
    "Empty/Leaf missing from export folders[]",
  );
  r = await req("POST", "/api/v1/backup/import", {
    token,
    body: {
      content: JSON.stringify(sepExport),
      format: "json",
      strategy: "replace_all",
      confirm_replace: true,
    },
  });
  assert("import_sep_replace", r.status === 200 && (r.json?.created ?? 0) >= 1, r.text.slice(0, 200));
  r = await req("GET", "/api/v1/folders", { token });
  const sepFolders = r.json?.items || r.json || [];
  const byName = Object.fromEntries(
    (Array.isArray(sepFolders) ? sepFolders : []).map((f) => [f.name, f]),
  );
  assert("restore_sep_parent", !!byName["A/B"], `folders=${Object.keys(byName)}`);
  assert("restore_sep_child", !!byName["C"] && byName["C"].parent_id === byName["A/B"]?.id, JSON.stringify(byName["C"]));
  assert("restore_empty_sep", !!byName["Empty/Leaf"], "Empty/Leaf missing after restore");
  const splitChain =
    byName["A"] &&
    byName["B"] &&
    byName["B"].parent_id === byName["A"].id &&
    byName["C"]?.parent_id === byName["B"].id;
  assert("restore_not_split_to_a_b_c", !splitChain, "A/B was split into A → B → C");
  r = await req("GET", `/api/v1/bookmarks?q=r7-sep`, { token });
  const sepBm = (r.json?.items || []).find((b) => b.url?.includes("r7-sep"));
  assert(
    "restore_sep_bookmark_folder",
    sepBm && sepBm.folder_id === byName["C"]?.id,
    JSON.stringify(sepBm || r.json).slice(0, 240),
  );

  console.log("\n--- summary ---");
  console.log(`passed=${results.filter((x) => x.ok).length} failed=${failed} total=${results.length}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
