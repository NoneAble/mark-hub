import { FormEvent, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";
import { QrCodeModal } from "@markhub/ui";
import { BookmarkCard } from "../../components/BookmarkCard";
import {
  EmptyState,
  Modal,
  SearchField,
  SearchModal,
  Toast,
  useSearchHotkey,
  useToast,
} from "../../components/ui";
import { visIcon } from "../../lib/colors";

type Folder = {
  id: string;
  parent_id: string | null;
  name: string;
  visibility?: string;
  is_system?: boolean;
};
type Bookmark = {
  id: string;
  folder_id: string;
  title: string;
  url: string;
  description?: string | null;
  visibility?: string;
  is_favorite?: boolean;
  is_archived?: boolean;
  tags?: Array<string | { name: string }>;
};

export function Dashboard() {
  const { api } = useAuth();
  const { t, lang } = useI18n();
  const { toast, showToast } = useToast();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [selected, setSelected] = useState<string | "all" | "fav">("all");
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [draft, setDraft] = useState({
    title: "",
    url: "",
    description: "",
    visibility: "private",
    folder_id: "",
    tags: "",
  });

  async function reload() {
    const home = await api.get<{ folders: Folder[]; bookmarks: Bookmark[] }>("/nav/home");
    setFolders(home.folders);
    setBookmarks(home.bookmarks as Bookmark[]);
  }

  useEffect(() => {
    void reload();
  }, [api]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of bookmarks) {
      if (b.is_archived) continue;
      m.set(b.folder_id, (m.get(b.folder_id) || 0) + 1);
    }
    return m;
  }, [bookmarks]);

  const treeNodes = useMemo(() => {
    const byParent = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const list = byParent.get(f.parent_id) || [];
      list.push(f);
      byParent.set(f.parent_id, list);
    }
    const out: { id: string | "all" | "fav"; name: string; icon: string; pad: number; count: number; vis?: string }[] = [
      { id: "all", name: t("all"), icon: "◉", pad: 0, count: bookmarks.filter((b) => !b.is_archived).length },
      { id: "fav", name: t("favorites"), icon: "★", pad: 0, count: bookmarks.filter((b) => b.is_favorite && !b.is_archived).length },
    ];
    function walk(parent: string | null, pad: number) {
      for (const f of byParent.get(parent) || []) {
        out.push({
          id: f.id,
          name: f.name,
          icon: f.is_system ? "⬇" : pad > 0 ? "·" : "📁",
          pad,
          count: counts.get(f.id) || 0,
          vis: f.visibility,
        });
        walk(f.id, pad + 14);
      }
    }
    walk(null, 0);
    return out;
  }, [folders, bookmarks, counts, t]);

  const searchItems = useMemo(
    () =>
      bookmarks
        .filter((b) => !b.is_archived)
        .map((b) => ({
          id: b.id,
          title: b.title,
          url: b.url,
          description: b.description,
          tags: b.tags,
        })),
    [bookmarks],
  );

  useSearchHotkey(() => setSearchOpen(true));

  const shown = useMemo(() => {
    return bookmarks.filter((b) => {
      if (b.is_archived) return false;
      if (selected === "fav" && !b.is_favorite) return false;
      if (selected !== "all" && selected !== "fav" && b.folder_id !== selected) return false;
      if (!q.trim()) return true;
      const qq = q.toLowerCase();
      const tags = (b.tags || []).map((x) => (typeof x === "string" ? x : x.name)).join(" ");
      return (
        b.title.toLowerCase().includes(qq) ||
        b.url.toLowerCase().includes(qq) ||
        (b.description || "").toLowerCase().includes(qq) ||
        tags.toLowerCase().includes(qq)
      );
    });
  }, [bookmarks, selected, q]);

  function openAdd() {
    setDraft({
      title: "",
      url: "",
      description: "",
      visibility: "private",
      folder_id: selected !== "all" && selected !== "fav" ? selected : folders.find((f) => f.is_system)?.id || folders[0]?.id || "",
      tags: "",
    });
    setAdding(true);
  }

  function openEdit(b: Bookmark) {
    setEditing(b);
    setDraft({
      title: b.title,
      url: b.url,
      description: b.description || "",
      visibility: b.visibility || "private",
      folder_id: b.folder_id,
      tags: (b.tags || []).map((x) => (typeof x === "string" ? x : x.name)).join(", "),
    });
  }

  async function saveAdd(e: FormEvent) {
    e.preventDefault();
    await api.post("/bookmarks", {
      title: draft.title,
      url: draft.url,
      description: draft.description,
      visibility: draft.visibility,
      folder_id: draft.folder_id || undefined,
      tags: draft.tags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setAdding(false);
    showToast(t("addBm"));
    await reload();
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    await api.patch(`/bookmarks/${editing.id}`, {
      title: draft.title,
      url: draft.url,
      description: draft.description,
      visibility: draft.visibility,
      folder_id: draft.folder_id || undefined,
      tags: draft.tags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setEditing(null);
    showToast(t("save"));
    await reload();
  }

  async function toggleFav(b: Bookmark) {
    await api.patch(`/bookmarks/${b.id}`, { is_favorite: !b.is_favorite });
    await reload();
  }

  async function deleteBm(b: Bookmark) {
    if (!confirm(t("delete") + "?")) return;
    await api.delete(`/bookmarks/${b.id}`);
    showToast(t("delete"));
    await reload();
  }

  async function shareFolder() {
    if (selected === "all" || selected === "fav") {
      showToast(lang === "zh" ? "请先选择一个文件夹" : "Select a folder first");
      return;
    }
    try {
      const r = await api.post<any>("/shares", { folder_id: selected });
      const url = `${window.location.origin}/s/${r.token || r.id}`;
      await navigator.clipboard.writeText(url);
      showToast(lang === "zh" ? "分享链接已复制" : "Share link copied");
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("failed"));
    }
  }

  const formFields = (
    <>
      <label className="field">
        {t("title")}
        <input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required />
      </label>
      <label className="field">
        {t("url")}
        <input className="input input-mono" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} required />
      </label>
      <label className="field">
        {t("description")}
        <input className="input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
      </label>
      <label className="field">
        {t("folders")}
        <select className="input" value={draft.folder_id} onChange={(e) => setDraft({ ...draft, folder_id: e.target.value })}>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        {t("visibility")}
        <select className="input" value={draft.visibility} onChange={(e) => setDraft({ ...draft, visibility: e.target.value })}>
          <option value="public">{t("public")}</option>
          <option value="unlisted">{t("unlisted")}</option>
          <option value="private">{t("private")}</option>
        </select>
      </label>
      <label className="field">
        {t("tagsField")}
        <input className="input" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
      </label>
    </>
  );

  return (
    <div className="dashboard-grid">
      <aside className="dashboard-tree" data-testid="folder-tree">
        <div className="stack" style={{ gap: 2 }}>
          {treeNodes.map((n) => (
            <button
              key={String(n.id)}
              type="button"
              className={`folder-item${selected === n.id ? " active" : ""}`}
              data-testid={typeof n.id === "string" && n.id !== "all" && n.id !== "fav" ? `folder-node-${n.id}` : undefined}
              onClick={() => setSelected(n.id)}
            >
              <span style={{ paddingLeft: n.pad, width: 15, textAlign: "center", color: "var(--text3)", flex: "none" }}>
                {n.icon}
              </span>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.name}</span>
              {n.vis ? <span style={{ fontSize: 10 }}>{visIcon(n.vis)}</span> : null}
              <span className="folder-count">{n.count}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn"
          style={{ marginTop: 10, width: "100%" }}
          data-testid="dashboard-all"
          onClick={() => setSelected("all")}
        >
          {t("allFolders")}
        </button>
      </aside>

      {/* Mobile: horizontal folder chips (prototype narrow layout) */}
      <div
        className="scroll-chips dashboard-tree-mobile"
        role="navigation"
        aria-label={t("folders")}
        data-testid="folder-tree-mobile"
      >
        {treeNodes.map((n) => (
          <button
            key={String(n.id)}
            type="button"
            className={`chip${selected === n.id ? " active" : ""}`}
            data-testid={
              typeof n.id === "string" && n.id !== "all" && n.id !== "fav"
                ? `folder-node-m-${n.id}`
                : undefined
            }
            onClick={() => setSelected(n.id)}
          >
            {n.name}
            <span className="chip-count">{n.count}</span>
          </button>
        ))}
      </div>

      <div className="dashboard-main">
        <div className="dashboard-toolbar" style={{ marginBottom: 18 }}>
          <SearchField
            value={q}
            onChange={setQ}
            placeholder={t("searchPh")}
            className="dashboard-search"
            testId="dashboard-search"
            shortcutHint
            onActivate={() => setSearchOpen(true)}
          />
          <span className="muted-sm" style={{ flex: "0 0 auto", whiteSpace: "nowrap" }}>
            {shown.length} {lang === "zh" ? "项" : "items"}
          </span>
          <div className="dashboard-toolbar-actions">
            <button type="button" className="btn btn-soft topbar-btn" onClick={() => void shareFolder()}>
              ⇗ {t("share")}
            </button>
            <button type="button" className="btn btn-primary topbar-btn" onClick={openAdd}>
              + {t("addBm")}
            </button>
          </div>
        </div>

        {shown.length ? (
          <div className="grid-cards" data-testid="bookmark-cards">
            {shown.map((b) => (
              <BookmarkCard
                key={b.id}
                bm={b}
                onFav={() => void toggleFav(b)}
                onEdit={() => openEdit(b)}
                onQr={() => setQrUrl(b.url)}
                onDelete={() => void deleteBm(b)}
              />
            ))}
          </div>
        ) : (
          <EmptyState>{t("empty")}</EmptyState>
        )}
      </div>

      <Modal
        open={adding}
        title={t("newBm")}
        onClose={() => setAdding(false)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              {t("cancel")}
            </button>
            <button type="submit" form="dash-add" className="btn btn-primary">
              {t("save")}
            </button>
          </>
        }
      >
        <form id="dash-add" className="stack" onSubmit={(e) => void saveAdd(e)}>
          {formFields}
        </form>
      </Modal>

      <Modal
        open={!!editing}
        title={t("editBm")}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              {t("cancel")}
            </button>
            <button type="submit" form="dash-edit" className="btn btn-primary">
              {t("save")}
            </button>
          </>
        }
      >
        <form id="dash-edit" className="stack" onSubmit={(e) => void saveEdit(e)}>
          {formFields}
        </form>
      </Modal>

      <SearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        items={searchItems}
        initialQuery={q}
        placeholder={t("searchPh")}
        emptyLabel={t("searchNoResults")}
        openLabel={t("searchOpen")}
      />

      <QrCodeModal url={qrUrl || ""} open={!!qrUrl} onClose={() => setQrUrl(null)} />
      <Toast message={toast} />
    </div>
  );
}
