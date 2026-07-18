import { useEffect, useMemo, useState } from "react";
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
import { useConfirm } from "../../components/form";
import {
  BookmarkForm,
  draftFromBookmark,
  emptyDraft,
  type TagLike,
} from "../../components/BookmarkForm";
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
  icon?: string | null;
  visibility?: string;
  is_favorite?: boolean;
  is_archived?: boolean;
  sort_order?: number;
  tags?: Array<string | { name: string }>;
};

export function Dashboard() {
  const { api } = useAuth();
  const { t, lang } = useI18n();
  const { toast, showToast } = useToast();
  const { confirm, confirmElement } = useConfirm();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [tags, setTags] = useState<TagLike[]>([]);
  const [selected, setSelected] = useState<string | "all" | "fav">("all");
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Bookmark | null>(null);

  async function reload() {
    const [home, tg] = await Promise.all([
      api.get<{ folders: Folder[]; bookmarks: Bookmark[] }>("/nav/home"),
      api.get<{ items: TagLike[] }>("/tags"),
    ]);
    setFolders(home.folders);
    setBookmarks(home.bookmarks as Bookmark[]);
    setTags(tg.items);
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
    const out: { id: string | "all" | "fav"; name: string; pad: number; count: number; vis?: string }[] = [
      { id: "all", name: t("all"), pad: 0, count: bookmarks.filter((b) => !b.is_archived).length },
      { id: "fav", name: t("favorites"), pad: 0, count: bookmarks.filter((b) => b.is_favorite && !b.is_archived).length },
    ];
    function walk(parent: string | null, pad: number) {
      for (const f of byParent.get(parent) || []) {
        out.push({
          id: f.id,
          name: f.name,
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
      const tagNames = (b.tags || []).map((x) => (typeof x === "string" ? x : x.name)).join(" ");
      return (
        b.title.toLowerCase().includes(qq) ||
        b.url.toLowerCase().includes(qq) ||
        (b.description || "").toLowerCase().includes(qq) ||
        tagNames.toLowerCase().includes(qq)
      );
    });
  }, [bookmarks, selected, q]);

  async function toggleFav(b: Bookmark) {
    await api.patch(`/bookmarks/${b.id}`, { is_favorite: !b.is_favorite });
    await reload();
  }

  async function deleteBm(b: Bookmark) {
    const ok = await confirm({ message: t("confirmDeleteBm"), danger: true });
    if (!ok) return;
    await api.delete(`/bookmarks/${b.id}`);
    showToast(t("delete") + " ✓");
    await reload();
  }

  const defaultFolderId =
    selected !== "all" && selected !== "fav" ? selected : "";

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
              <span
                style={{
                  paddingLeft: n.pad,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {n.name}
              </span>
              {n.vis ? <span style={{ fontSize: 10 }}>{visIcon(n.vis)}</span> : null}
              <span className="folder-count">{n.count}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Mobile: horizontal category chips (prototype narrow layout) */}
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
            {shown.length} {t("itemsUnit")}
          </span>
          <div className="dashboard-toolbar-actions">
            <button type="button" className="btn btn-primary topbar-btn" onClick={() => setAdding(true)}>
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
                onEdit={() => setEditing(b)}
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
        wide
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
        <BookmarkForm
          api={api}
          formId="dash-add"
          initial={emptyDraft(defaultFolderId)}
          folders={folders}
          tags={tags}
          showArchived={false}
          onNotice={showToast}
          onSaved={() => {
            setAdding(false);
            showToast(t("addBm") + " ✓");
            void reload();
          }}
        />
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
            <button type="submit" form="dash-edit" className="btn btn-primary">
              {t("save")}
            </button>
          </>
        }
      >
        {editing ? (
          <BookmarkForm
            api={api}
            formId="dash-edit"
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
              void reload();
            }}
          />
        ) : null}
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
      {confirmElement}
      <Toast message={toast} />
    </div>
  );
}
