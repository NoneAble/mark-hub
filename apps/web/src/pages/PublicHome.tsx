import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../i18n";
import { BookmarkCard } from "../components/BookmarkCard";
import {
  LogoMark,
  Modal,
  SearchField,
  SearchModal,
  Toast,
  useSearchHotkey,
  useToast,
} from "../components/ui";
import { useConfirm } from "../components/form";
import {
  BookmarkForm,
  draftFromBookmark,
  emptyDraft,
  type FolderLike,
  type TagLike,
} from "../components/BookmarkForm";
import { currentTheme, initThemeFromStorage, toggleTheme } from "../lib/theme";

type NavNode = {
  type: "folder" | "bookmark";
  id: string;
  name?: string;
  title?: string;
  url?: string;
  description?: string | null;
  icon?: string | null;
  visibility?: string;
  folder_id?: string;
  sort_order?: number;
  is_archived?: boolean;
  tags?: Array<string | { name: string }>;
  children?: NavNode[];
};

function countBookmarks(node: NavNode): number {
  if (node.type === "bookmark") return 1;
  return (node.children || []).reduce((n, c) => n + countBookmarks(c), 0);
}

function collectTags(nodes: NavNode[], out = new Set<string>()): string[] {
  for (const n of nodes) {
    if (n.type === "bookmark" && n.tags) {
      for (const tg of n.tags) out.add(typeof tg === "string" ? tg : tg.name);
    }
    if (n.children) collectTags(n.children, out);
  }
  return [...out].sort();
}

function flattenBookmarks(node: NavNode): NavNode[] {
  if (node.type === "bookmark") return [node];
  return (node.children || []).flatMap(flattenBookmarks);
}

function matchesQuery(n: NavNode, qq: string): boolean {
  if (n.type === "bookmark") {
    const tags = (n.tags || []).map((t) => (typeof t === "string" ? t : t.name)).join(" ");
    return (
      (n.title || "").toLowerCase().includes(qq) ||
      (n.url || "").toLowerCase().includes(qq) ||
      (n.description || "").toLowerCase().includes(qq) ||
      tags.toLowerCase().includes(qq)
    );
  }
  return (n.name || "").toLowerCase().includes(qq);
}

function filterTree(nodes: NavNode[], qq: string): NavNode[] {
  if (!qq) return nodes;
  return nodes
    .map((n) => {
      if (n.type === "bookmark") return matchesQuery(n, qq) ? n : null;
      const kids = filterTree(n.children || [], qq);
      if (kids.length || matchesQuery(n, qq)) return { ...n, children: kids };
      return null;
    })
    .filter(Boolean) as NavNode[];
}

function hasTag(n: NavNode, tag: string): boolean {
  return (n.tags || []).some((t) => (typeof t === "string" ? t : t.name) === tag);
}

function filterTreeByTag(nodes: NavNode[], tag: string): NavNode[] {
  return nodes
    .map((n) => {
      if (n.type === "bookmark") return hasTag(n, tag) ? n : null;
      const kids = filterTreeByTag(n.children || [], tag);
      return kids.length ? { ...n, children: kids } : null;
    })
    .filter(Boolean) as NavNode[];
}

type HomeFolder = FolderLike & { visibility?: string; sort_order?: number };
type HomeBookmark = {
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

/** Build a public-nav-shaped tree from the authenticated flat /nav/home payload. */
function buildTreeFromHome(folders: HomeFolder[], bookmarks: HomeBookmark[]): NavNode[] {
  const nodeById = new Map<string, NavNode>();
  for (const f of folders) {
    nodeById.set(f.id, {
      type: "folder",
      id: f.id,
      name: f.name,
      visibility: f.visibility,
      sort_order: f.sort_order ?? 0,
      children: [],
    });
  }
  const roots: NavNode[] = [];
  for (const f of folders) {
    const node = nodeById.get(f.id)!;
    const parent = f.parent_id ? nodeById.get(f.parent_id) : undefined;
    if (parent) parent.children!.push(node);
    else roots.push(node);
  }
  for (const b of bookmarks) {
    if (b.is_archived) continue;
    const parent = nodeById.get(b.folder_id);
    const node: NavNode = {
      type: "bookmark",
      id: b.id,
      title: b.title,
      url: b.url,
      description: b.description,
      icon: b.icon,
      visibility: b.visibility,
      folder_id: b.folder_id,
      sort_order: b.sort_order ?? 0,
      tags: b.tags,
    };
    if (parent) parent.children!.push(node);
  }
  const sortRec = (nodes: NavNode[]) => {
    nodes.sort(
      (a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        (a.name || a.title || "").localeCompare(b.name || b.title || ""),
    );
    for (const n of nodes) if (n.children) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

export function PublicHome() {
  const { api, token } = useAuth();
  const { t, lang, toggleLang } = useI18n();
  const { toast, showToast } = useToast();
  const { confirm, confirmElement } = useConfirm();
  const [tree, setTree] = useState<NavNode[]>([]);
  const [folders, setFolders] = useState<HomeFolder[]>([]);
  const [tags, setTags] = useState<TagLike[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState<string | "all">("all");
  const [selTag, setSelTag] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [editing, setEditing] = useState<NavNode | null>(null);
  const [adding, setAdding] = useState(false);

  async function reload() {
    if (token) {
      // Logged in: full data incl. private/unlisted bookmarks
      const [home, tg] = await Promise.all([
        api.get<{ folders: HomeFolder[]; bookmarks: HomeBookmark[] }>("/nav/home"),
        api.get<{ items: TagLike[] }>("/tags"),
      ]);
      setFolders(home.folders);
      setTags(tg.items);
      setTree(buildTreeFromHome(home.folders, home.bookmarks));
    } else {
      const r = await api.get<{ tree: NavNode[] }>("/nav/public");
      setTree(r.tree || []);
      setFolders([]);
      setTags([]);
    }
  }

  useEffect(() => {
    initThemeFromStorage();
    setTheme(currentTheme());
    void reload();
  }, [api, token]);

  const folderNodes = useMemo(() => tree.filter((n) => n.type === "folder"), [tree]);
  const allTags = useMemo(() => collectTags(tree), [tree]);

  const searchItems = useMemo(
    () =>
      flattenBookmarks({ type: "folder", id: "__root", children: tree }).map((n) => ({
        id: n.id,
        title: n.title || "",
        url: n.url || "",
        description: n.description,
        tags: n.tags,
      })),
    [tree],
  );

  useSearchHotkey(() => setSearchOpen(true));

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    let base = tree;
    if (selected !== "all") {
      const find = (nodes: NavNode[]): NavNode | null => {
        for (const n of nodes) {
          if (n.id === selected) return n;
          if (n.children) {
            const f = find(n.children);
            if (f) return f;
          }
        }
        return null;
      };
      const node = find(tree);
      base = node ? [node] : [];
    }
    if (selTag) base = filterTreeByTag(base, selTag);
    return filterTree(base, qq);
  }, [tree, selected, selTag, q]);

  const groups = useMemo(() => {
    if (selected === "all") {
      return filtered
        .filter((n) => n.type === "folder")
        .flatMap((n) => {
          const groupsLocal: { id: string; name: string; items: NavNode[] }[] = [];
          const direct = (n.children || []).filter((c) => c.type === "bookmark");
          if (direct.length) groupsLocal.push({ id: n.id, name: n.name || "", items: direct });
          for (const c of n.children || []) {
            if (c.type === "folder") {
              const items = flattenBookmarks(c);
              if (items.length) groupsLocal.push({ id: c.id, name: c.name || "", items });
            }
          }
          return groupsLocal;
        });
    }
    const out: { id: string; name: string; items: NavNode[] }[] = [];
    for (const n of filtered) {
      if (n.type === "bookmark") {
        const existing = out.find((g) => g.id === "__root");
        if (existing) existing.items.push(n);
        else out.push({ id: "__root", name: t("all"), items: [n] });
      } else {
        const items = flattenBookmarks(n);
        if (items.length) out.push({ id: n.id, name: n.name || "", items });
      }
    }
    return out;
  }, [filtered, selected, t]);

  async function deleteBm(id: string) {
    const ok = await confirm({ message: t("confirmDeleteBm"), danger: true });
    if (!ok) return;
    await api.delete(`/bookmarks/${id}`);
    showToast(t("delete") + " ✓");
    await reload();
  }

  const folderNav = useMemo(() => {
    const items: { id: string | "all"; name: string; count: number; pad: number }[] = [
      {
        id: "all",
        name: t("allFolders"),
        count: folderNodes.reduce((n, f) => n + countBookmarks(f), 0),
        pad: 0,
      },
    ];
    for (const f of folderNodes) {
      items.push({ id: f.id, name: f.name || "", count: countBookmarks(f), pad: 0 });
      for (const c of f.children || []) {
        if (c.type === "folder") {
          items.push({ id: c.id, name: c.name || "", count: countBookmarks(c), pad: 14 });
        }
      }
    }
    return items;
  }, [folderNodes, t]);

  const defaultFolderId = selected !== "all" ? selected : "";

  return (
    <div className="public-page">
      <header className="public-topbar">
        <div className="public-brand">
          <LogoMark size={28} />
          <strong style={{ fontSize: 16 }}>{t("appName")}</strong>
        </div>
        <SearchField
          value={q}
          onChange={setQ}
          placeholder={t("searchPh")}
          filled
          className="public-search"
          shortcutHint
          onActivate={() => setSearchOpen(true)}
        />
        <div className="public-actions">
          {token && editMode ? (
            <button
              type="button"
              className="btn btn-primary topbar-btn"
              onClick={() => setAdding(true)}
            >
              + {t("addBm")}
            </button>
          ) : null}
          {token ? (
            <button
              type="button"
              className="btn btn-soft topbar-btn"
              onClick={() => setEditMode((v) => !v)}
            >
              {editMode ? t("exitEdit") : t("editMode")}
            </button>
          ) : null}
          <button type="button" className="btn topbar-btn" onClick={toggleLang}>
            {lang === "zh" ? "EN" : "中"}
          </button>
          <button
            type="button"
            className="btn topbar-btn"
            onClick={() => setTheme(toggleTheme())}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          {token ? (
            <Link className="btn btn-primary topbar-btn" to="/app">
              {t("workbench")}
            </Link>
          ) : (
            <Link className="btn btn-primary topbar-btn" to="/admin/login">
              {t("login")}
            </Link>
          )}
        </div>
      </header>

      {/* Mobile: horizontal category chips (prototype narrow layout) */}
      <div className="scroll-chips public-folder-chips" role="navigation" aria-label={t("folders")}>
        {folderNav.map((n) => (
          <button
            key={n.id}
            type="button"
            className={`chip${selected === n.id ? " active" : ""}`}
            onClick={() => setSelected(n.id)}
          >
            {n.name}
            <span className="chip-count">{n.count}</span>
          </button>
        ))}
        {allTags.slice(0, 6).map((tg) => (
          <button
            key={`tag-${tg}`}
            type="button"
            className={`chip${selTag === tg ? " active" : ""}`}
            onClick={() => setSelTag((cur) => (cur === tg ? null : tg))}
          >
            #{tg}
          </button>
        ))}
      </div>

      <div className="public-body">
        <aside className="public-aside">
          <div className="section-label" style={{ padding: "0 12px 10px" }}>
            {t("folders")}
          </div>
          <div className="stack" style={{ gap: 2 }}>
            {folderNav.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`folder-item${selected === n.id ? " active" : ""}`}
                onClick={() => setSelected(n.id)}
              >
                <span style={{ paddingLeft: n.pad }}>{n.name}</span>
                <span className="folder-count">{n.count}</span>
              </button>
            ))}
          </div>
          {allTags.length ? (
            <>
              <div
                className="section-label"
                style={{
                  margin: "18px 12px 0",
                  paddingTop: 14,
                  borderTop: "1px solid var(--border)",
                }}
              >
                {t("tags")}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "10px 12px 0" }}>
                {allTags.map((tg) => (
                  <button
                    key={tg}
                    type="button"
                    className={`tag-chip${selTag === tg ? " active" : ""}`}
                    style={{ cursor: "pointer", border: "none" }}
                    onClick={() => setSelTag((cur) => (cur === tg ? null : tg))}
                  >
                    #{tg}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </aside>

        <div className="public-content">
          {!groups.length ? (
            <div className="empty-state">{t("noPublicBookmarks")}</div>
          ) : (
            groups.map((g) => (
              <section key={g.id} style={{ marginBottom: 26 }}>
                <div className="row" style={{ gap: 10, marginBottom: 14, alignItems: "baseline" }}>
                  <span style={{ fontSize: 16, fontWeight: 700 }}>{g.name}</span>
                  <span className="muted-sm">
                    {g.items.length} {t("itemsUnit")}
                  </span>
                </div>
                <div className="grid-cards">
                  {g.items.map((bm) => (
                    <BookmarkCard
                      key={bm.id}
                      bm={{
                        id: bm.id,
                        title: bm.title || "",
                        url: bm.url || "",
                        description: bm.description,
                        icon: bm.icon,
                        visibility: bm.visibility,
                        tags: bm.tags,
                      }}
                      editMode={editMode && !!token}
                      linkTitleOnly={false}
                      onEdit={editMode && token ? () => setEditing(bm) : undefined}
                      onDelete={editMode && token ? () => void deleteBm(bm.id) : undefined}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      <footer className="foot-note">MarkHub · {t("footNote")}</footer>

      <SearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        items={searchItems}
        initialQuery={q}
        placeholder={t("searchPh")}
        emptyLabel={t("searchNoResults")}
        openLabel={t("searchOpen")}
      />

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
            <button type="submit" form="public-edit-bm" className="btn btn-primary">
              {t("save")}
            </button>
          </>
        }
      >
        {editing ? (
          <BookmarkForm
            api={api}
            formId="public-edit-bm"
            key={editing.id}
            initial={draftFromBookmark({ ...editing, folder_id: editing.folder_id })}
            editingId={editing.id}
            folders={folders}
            tags={tags}
            onNotice={showToast}
            onSaved={() => {
              setEditing(null);
              showToast(t("save") + " ✓");
              void reload();
            }}
          />
        ) : null}
      </Modal>

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
            <button type="submit" form="public-add-bm" className="btn btn-primary">
              {t("save")}
            </button>
          </>
        }
      >
        {adding ? (
          <BookmarkForm
            api={api}
            formId="public-add-bm"
            initial={{ ...emptyDraft(defaultFolderId), visibility: "public" }}
            folders={folders}
            tags={tags}
            onNotice={showToast}
            onSaved={() => {
              setAdding(false);
              showToast(t("addBm") + " ✓");
              void reload();
            }}
          />
        ) : null}
      </Modal>

      {confirmElement}
      <Toast message={toast} />
    </div>
  );
}
