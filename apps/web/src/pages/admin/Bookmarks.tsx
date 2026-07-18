import { FormEvent, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";
import { EmptyState, Modal, PageHeader, Toast, useToast } from "../../components/ui";
import { Combobox, useConfirm, type ComboOption } from "../../components/form";
import {
  BookmarkForm,
  draftFromBookmark,
  emptyDraft,
  type FolderLike,
  type TagLike,
} from "../../components/BookmarkForm";
import { visIcon } from "../../lib/colors";

type Bookmark = {
  id: string;
  folder_id: string;
  title: string;
  url: string;
  description?: string | null;
  icon?: string | null;
  visibility: string;
  is_favorite: boolean;
  is_archived: boolean;
  sort_order?: number;
  tags?: Array<string | { name: string }>;
};

export function AdminBookmarks() {
  const { api } = useAuth();
  const { t } = useI18n();
  const { toast, showToast } = useToast();
  const { confirm, confirmElement } = useConfirm();
  const [items, setItems] = useState<Bookmark[]>([]);
  const [folders, setFolders] = useState<(FolderLike & { visibility?: string })[]>([]);
  const [tags, setTags] = useState<TagLike[]>([]);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [quick, setQuick] = useState({ title: "", url: "" });
  const [error, setError] = useState("");
  const [batchAction, setBatchAction] = useState("delete");
  const [batchFolder, setBatchFolder] = useState("");
  const [batchVisibility, setBatchVisibility] = useState("public");

  async function load() {
    const [bm, fd, tg] = await Promise.all([
      api.get<{ items: Bookmark[] }>(`/bookmarks?q=${encodeURIComponent(q)}&limit=200`),
      api.get<{ items: (FolderLike & { visibility?: string })[] }>("/folders"),
      api.get<{ items: TagLike[] }>("/tags"),
    ]);
    setItems(bm.items);
    setFolders(fd.items);
    setTags(tg.items);
  }

  useEffect(() => {
    void load().catch((e) => setError(String(e.message || e)));
  }, []);

  const folderName = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of folders) m.set(f.id, f.name);
    return m;
  }, [folders]);

  const folderOptions = useMemo<ComboOption[]>(
    () => folders.map((f) => ({ value: f.id, label: f.name })),
    [folders],
  );

  const batchOptions: ComboOption[] = [
    { value: "delete", label: t("delete") },
    { value: "move", label: t("move") },
    { value: "set_visibility", label: t("visibility") },
    { value: "set_archived", label: t("archive") },
  ];

  async function onQuickAdd(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api.post("/bookmarks", {
        title: quick.title || quick.url,
        url: quick.url,
      });
      setQuick({ title: "", url: "" });
      showToast(t("addBm") + " ✓");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDelete(id: string) {
    const ok = await confirm({ message: t("confirmDeleteBm"), danger: true });
    if (!ok) return;
    await api.delete(`/bookmarks/${id}`);
    await load();
  }

  async function toggleFavorite(b: Bookmark) {
    await api.patch(`/bookmarks/${b.id}`, { is_favorite: !b.is_favorite });
    await load();
  }

  async function toggleArchived(b: Bookmark) {
    await api.patch(`/bookmarks/${b.id}`, { is_archived: !b.is_archived });
    await load();
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function toggleSelectAll() {
    if (selected.size === items.length) setSelected(new Set());
    else setSelected(new Set(items.map((b) => b.id)));
  }

  async function runBatch() {
    const ids = [...selected];
    if (!ids.length) return;
    if (batchAction === "delete") {
      const ok = await confirm({
        message: `${t("confirmDeleteBm")} (${ids.length})`,
        danger: true,
      });
      if (!ok) return;
    }
    // Canonical shape: action + ids + nested payload (R4-F014 / OpenAPI)
    const body: { action: string; ids: string[]; payload?: Record<string, unknown> } = {
      action: batchAction,
      ids,
    };
    if (batchAction === "move") {
      body.payload = { folder_id: batchFolder || folders[0]?.id };
    } else if (batchAction === "set_visibility") {
      body.payload = { visibility: batchVisibility };
    } else if (batchAction === "set_archived") {
      body.payload = { is_archived: true };
    }
    await api.post("/bookmarks/batch", body);
    setSelected(new Set());
    showToast(`${t("batch")} ✓`);
    await load();
  }

  return (
    <div>
      <PageHeader title={t("bookmarks")} />
      {error ? <div className="error" style={{ marginBottom: 10 }}>{error}</div> : null}

      {/* Quick add (title + url); the full form lives in the modal */}
      <form className="card row wrap" onSubmit={(e) => void onQuickAdd(e)} style={{ marginBottom: 14 }}>
        <span className="section-label" style={{ flex: "none" }}>{t("quickAdd")}</span>
        <input
          className="input"
          style={{ flex: 1, minWidth: 130 }}
          placeholder={t("title")}
          value={quick.title}
          onChange={(e) => setQuick({ ...quick, title: e.target.value })}
        />
        <input
          className="input input-mono"
          style={{ flex: 2, minWidth: 170 }}
          placeholder={t("url")}
          value={quick.url}
          onChange={(e) => setQuick({ ...quick, url: e.target.value })}
          required
        />
        <button className="btn btn-primary" type="submit">
          {t("add")}
        </button>
        <button type="button" className="btn btn-soft" onClick={() => setAdding(true)}>
          ⊞ {t("fullForm")}
        </button>
      </form>

      <div className="row wrap" style={{ marginBottom: 12, gap: 8 }}>
        <input
          className="input"
          style={{ maxWidth: 300, flex: 1, minWidth: 150 }}
          placeholder={t("search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load()}
        />
        <button className="btn" type="button" onClick={() => void load()}>
          {t("search")}
        </button>
        <div style={{ width: 130, flex: "none" }}>
          <Combobox value={batchAction} options={batchOptions} onChange={setBatchAction} />
        </div>
        {batchAction === "move" ? (
          <div style={{ width: 170, flex: "none" }}>
            <Combobox
              value={batchFolder || folders[0]?.id || ""}
              options={folderOptions}
              onChange={setBatchFolder}
              placeholder={t("category")}
            />
          </div>
        ) : null}
        {batchAction === "set_visibility" ? (
          <div style={{ width: 130, flex: "none" }}>
            <Combobox
              value={batchVisibility}
              options={[
                { value: "public", label: t("public") },
                { value: "unlisted", label: t("unlisted") },
                { value: "private", label: t("private") },
              ]}
              onChange={setBatchVisibility}
            />
          </div>
        ) : null}
        <button className="btn" type="button" disabled={!selected.size} onClick={() => void runBatch()}>
          {t("batch")} ({selected.size})
        </button>
      </div>

      {items.length ? (
        <div className="card card-flush" style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 34 }}>
                  <input
                    type="checkbox"
                    checked={items.length > 0 && selected.size === items.length}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th>{t("title")}</th>
                <th>{t("category")}</th>
                <th>{t("tags")}</th>
                <th>{t("visibility")}</th>
                <th style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((b) => (
                <tr key={b.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(b.id)}
                      onChange={() => toggleSelect(b.id)}
                    />
                  </td>
                  <td>
                    <div className="row" style={{ gap: 8, flexWrap: "nowrap", minWidth: 180 }}>
                      {b.icon ? (
                        <img
                          src={b.icon}
                          alt=""
                          width={20}
                          height={20}
                          style={{ borderRadius: 5, flex: "none", objectFit: "contain" }}
                        />
                      ) : null}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 500, display: "flex", gap: 5, alignItems: "center" }}>
                          {b.is_favorite ? <span style={{ color: "var(--warn)" }}>★</span> : null}
                          {b.is_archived ? <span title={t("archived")}>📦</span> : null}
                          <a href={b.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                            {b.title}
                          </a>
                        </div>
                        <div className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: 320 }}>
                          {b.url}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="badge">{folderName.get(b.folder_id) || "—"}</span>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {(b.tags || []).slice(0, 4).map((tg, i) => {
                        const name = typeof tg === "string" ? tg : tg.name;
                        return (
                          <span key={`${name}-${i}`} className="tag-chip">
                            #{name}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td>
                    <span className="badge">
                      {visIcon(b.visibility)} {t(b.visibility as "private" | "unlisted" | "public")}
                    </span>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 2, flexWrap: "nowrap", justifyContent: "flex-end" }}>
                      <button
                        className="btn-icon"
                        type="button"
                        title={t("favorite")}
                        style={{ color: b.is_favorite ? "var(--warn)" : undefined }}
                        onClick={() => void toggleFavorite(b)}
                      >
                        {b.is_favorite ? "★" : "☆"}
                      </button>
                      <button
                        className="btn-icon"
                        type="button"
                        title={b.is_archived ? t("unarchive") : t("archive")}
                        onClick={() => void toggleArchived(b)}
                      >
                        {b.is_archived ? "📤" : "📦"}
                      </button>
                      <button className="btn-icon" type="button" title={t("edit")} onClick={() => setEditing(b)}>
                        ✎
                      </button>
                      <button className="btn-icon" type="button" title={t("delete")} onClick={() => void onDelete(b.id)}>
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState>{t("empty")}</EmptyState>
      )}

      <Modal
        open={adding}
        wide
        title={t("newBm")}
        onClose={() => setAdding(false)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              {t("cancel")}
            </button>
            <button type="submit" form="admin-add-bm" className="btn btn-primary">
              {t("save")}
            </button>
          </>
        }
      >
        {adding ? (
          <BookmarkForm
            api={api}
            formId="admin-add-bm"
            initial={emptyDraft()}
            folders={folders}
            tags={tags}
            showArchived
            onNotice={showToast}
            onSaved={() => {
              setAdding(false);
              showToast(t("addBm") + " ✓");
              void load();
            }}
          />
        ) : null}
      </Modal>

      <Modal
        open={!!editing}
        wide
        title={t("editBm")}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              {t("cancel")}
            </button>
            <button type="submit" form="admin-edit-bm" className="btn btn-primary">
              {t("save")}
            </button>
          </>
        }
      >
        {editing ? (
          <BookmarkForm
            api={api}
            formId="admin-edit-bm"
            key={editing.id}
            initial={draftFromBookmark(editing)}
            editingId={editing.id}
            folders={folders}
            tags={tags}
            showArchived
            onNotice={showToast}
            onSaved={() => {
              setEditing(null);
              showToast(t("save") + " ✓");
              void load();
            }}
          />
        ) : null}
      </Modal>

      {confirmElement}
      <Toast message={toast} />
    </div>
  );
}
