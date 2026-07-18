import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { useI18n } from "../i18n";
import { BookmarkCard } from "../components/BookmarkCard";
import {
  LogoMark,
  Modal,
  SearchField,
  SearchModal,
  Toast,
  useEditHotkey,
  useSearchHotkey,
  useToast,
} from "../components/ui";
import { Combobox, useClickOutside, useConfirm, type ComboOption } from "../components/form";
import {
  BookmarkForm,
  draftFromBookmark,
  emptyDraft,
  type TagLike,
} from "../components/BookmarkForm";
import { FolderModal, TagModal, useDeleteFolder, type ManagedFolder } from "../components/ManageModals";
import { LoginModal } from "../components/LoginModal";
import { SettingsModal, type SettingsTab } from "../components/SettingsModal";
import { UserMenu } from "../components/UserMenu";
import { currentTheme, initThemeFromStorage, toggleTheme } from "../lib/theme";
import { visIcon } from "../lib/colors";

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
  is_system?: boolean;
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

/** Keep only bookmarks matching `pred` (folders collapse when empty). */
function filterTreeBy(nodes: NavNode[], pred: (n: NavNode) => boolean): NavNode[] {
  return nodes
    .map((n) => {
      if (n.type === "bookmark") return pred(n) ? n : null;
      const kids = filterTreeBy(n.children || [], pred);
      return kids.length ? { ...n, children: kids } : null;
    })
    .filter(Boolean) as NavNode[];
}

function hasTag(n: NavNode, tag: string): boolean {
  return (n.tags || []).some((t) => (typeof t === "string" ? t : t.name) === tag);
}

type HomeBookmark = {
  id: string;
  folder_id: string;
  title: string;
  url: string;
  description?: string | null;
  icon?: string | null;
  visibility?: string;
  is_archived?: boolean;
  sort_order?: number;
  tags?: Array<string | { name: string }>;
};

/** Build a public-nav-shaped tree from the authenticated flat folder+bookmark payload. */
function buildTreeFromHome(folders: ManagedFolder[], bookmarks: HomeBookmark[]): NavNode[] {
  const nodeById = new Map<string, NavNode>();
  for (const f of folders) {
    nodeById.set(f.id, {
      type: "folder",
      id: f.id,
      name: f.name,
      visibility: f.visibility,
      sort_order: f.sort_order ?? 0,
      is_system: f.is_system,
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

type Selected = string | "all" | "archived";

/** Right-click context menu for category rows (edit mode), themed like the user menu. */
function FolderContextMenu({
  name,
  x,
  y,
  onEdit,
  onDelete,
  onClose,
}: {
  name: string;
  x: number;
  y: number;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const rootRef = useClickOutside(onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Keep the menu inside the viewport when invoked near an edge
  const left = Math.max(8, Math.min(x, window.innerWidth - 170));
  const top = Math.max(8, Math.min(y, window.innerHeight - 140));

  return (
    <div
      className="menu folder-context-menu"
      role="menu"
      ref={rootRef}
      style={{ left, top }}
      data-testid="folder-context-menu"
    >
      <div className="menu-label">{name}</div>
      <button
        type="button"
        className="menu-item"
        role="menuitem"
        data-testid="folder-menu-edit"
        onClick={onEdit}
      >
        {t("edit")}
      </button>
      <div className="menu-sep" role="separator" />
      <button
        type="button"
        className="menu-item danger"
        role="menuitem"
        data-testid="folder-menu-delete"
        onClick={onDelete}
      >
        {t("delete")}
      </button>
    </div>
  );
}

export function PublicHome() {
  const { api, token, user, logout } = useAuth();
  const { t, lang, toggleLang } = useI18n();
  const { toast, showToast } = useToast();
  const { confirm, confirmElement } = useConfirm();
  const { deleteFolder, deleteFolderElement } = useDeleteFolder(api);

  const [tree, setTree] = useState<NavNode[]>([]);
  const [folders, setFolders] = useState<ManagedFolder[]>([]);
  const [rawBookmarks, setRawBookmarks] = useState<HomeBookmark[]>([]);
  const [tags, setTags] = useState<TagLike[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState<Selected>("all");
  const [selTag, setSelTag] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [editing, setEditing] = useState<NavNode | null>(null);
  const [adding, setAdding] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [settings, setSettings] = useState<{ open: boolean; tab: SettingsTab }>({
    open: false,
    tab: "account",
  });
  const [folderModal, setFolderModal] = useState<{ open: boolean; folder: ManagedFolder | null }>({
    open: false,
    folder: null,
  });
  const [tagModal, setTagModal] = useState<{ id: string; name: string } | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const forcePw = !!token && !!user?.must_change_password;

  const reload = useCallback(async () => {
    try {
      if (token) {
        // Logged in: full data incl. private/unlisted/archived bookmarks
        const [home, tg, fd] = await Promise.all([
          api.get<{ bookmarks: HomeBookmark[] }>("/nav/home"),
          api.get<{ items: TagLike[] }>("/tags"),
          api.get<{ items: ManagedFolder[] }>("/folders"),
        ]);
        setFolders(fd.items);
        setTags(tg.items);
        setRawBookmarks(home.bookmarks);
        setTree(buildTreeFromHome(fd.items, home.bookmarks));
        // Drop selected ids that no longer exist (deleted / cascade-deleted)
        setSelection((prev) => {
          if (!prev.size) return prev;
          const alive = new Set(home.bookmarks.map((b) => b.id));
          const next = new Set([...prev].filter((id) => alive.has(id)));
          return next.size === prev.size ? prev : next;
        });
      } else {
        const r = await api.get<{ tree: NavNode[] }>("/nav/public");
        setTree(r.tree || []);
        setFolders([]);
        setTags([]);
        setRawBookmarks([]);
      }
    } catch (e) {
      // While must_change_password is set the server 403s data routes — expected;
      // the forced settings modal handles it and we reload after the change.
      if (!(token && user?.must_change_password)) {
        showToast(e instanceof Error ? e.message : String(e));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, token, user?.must_change_password]);

  useEffect(() => {
    initThemeFromStorage();
    setTheme(currentTheme());
    void reload();
  }, [reload]);

  // After the forced password change completes, the server stops 403-ing data
  // routes — fetch the real data (the login-time reload was rejected).
  const prevForcePw = useRef(forcePw);
  useEffect(() => {
    if (prevForcePw.current && !forcePw && token) void reload();
    prevForcePw.current = forcePw;
  }, [forcePw, token, reload]);

  // Logged out: leave edit state cleanly
  useEffect(() => {
    if (!token) {
      setEditMode(false);
      setSelection(new Set());
      setSelected("all");
      setSettings((s) => (s.open ? { ...s, open: false } : s));
    }
  }, [token]);

  // Forced password change: open the account settings modal and keep it open
  useEffect(() => {
    if (forcePw) setSettings({ open: true, tab: "account" });
  }, [forcePw]);

  // Drop selections that no longer resolve after a reload
  useEffect(() => {
    if (
      typeof selected === "string" &&
      selected !== "all" &&
      selected !== "archived" &&
      token &&
      folders.length &&
      !folders.some((f) => f.id === selected)
    ) {
      setSelected("all");
    }
  }, [folders, selected, token]);

  const archivedBookmarks = useMemo(
    () => rawBookmarks.filter((b) => b.is_archived),
    [rawBookmarks],
  );

  useSearchHotkey(() => setSearchOpen(true));
  useEditHotkey(() => setEditMode((v) => !v), !!token);

  /* ---------- derived data ---------- */

  const treeCounts = useMemo(() => {
    const m = new Map<string, number>();
    const walk = (nodes: NavNode[]) => {
      for (const n of nodes) {
        if (n.type === "folder") {
          m.set(n.id, countBookmarks(n));
          if (n.children) walk(n.children);
        }
      }
    };
    walk(tree);
    return m;
  }, [tree]);

  type FolderRow = {
    id: string;
    name: string;
    pad: number;
    count: number;
    visibility?: string;
  };

  const folderRows = useMemo<FolderRow[]>(() => {
    const out: FolderRow[] = [];
    const walk = (nodes: NavNode[], pad: number) => {
      for (const n of nodes) {
        if (n.type !== "folder") continue;
        if (n.is_system) {
          // The system folder is just "All" — hide the row, lift nested folders
          if (n.children) walk(n.children, pad);
          continue;
        }
        out.push({
          id: n.id,
          name: n.name || "",
          pad,
          count: treeCounts.get(n.id) || 0,
          visibility: n.visibility,
        });
        if (n.children) walk(n.children, pad + 14);
      }
    };
    walk(tree, 0);
    return out;
  }, [tree, treeCounts]);

  const totalCount = useMemo(
    () => tree.filter((n) => n.type === "folder").reduce((n, f) => n + countBookmarks(f), 0),
    [tree],
  );

  const tagUsage = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of rawBookmarks) {
      for (const x of b.tags || []) {
        const n = typeof x === "string" ? x : x.name;
        m.set(n, (m.get(n) || 0) + 1);
      }
    }
    return m;
  }, [rawBookmarks]);

  /** Sidebar tags: full managed list when logged in, otherwise collected from the public tree. */
  const sidebarTags = useMemo<{ name: string; id?: string }[]>(() => {
    if (token && tags.length) {
      return [...tags]
        .sort(
          (a, b) =>
            (tagUsage.get(b.name) || 0) - (tagUsage.get(a.name) || 0) ||
            a.name.localeCompare(b.name),
        )
        .map((x) => ({ name: x.name, id: x.id }));
    }
    return collectTags(tree).map((name) => ({ name }));
  }, [token, tags, tagUsage, tree]);

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

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    let base = tree;
    if (selected !== "all" && selected !== "archived") {
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
    if (selTag) base = filterTreeBy(base, (n) => hasTag(n, selTag));
    return filterTree(base, qq);
  }, [tree, selected, selTag, q]);

  const groups = useMemo(() => {
    if (selected === "archived") {
      const qq = q.trim().toLowerCase();
      const items = archivedBookmarks
        .filter((b) => (selTag ? hasTag(b as NavNode, selTag) : true))
        .map<NavNode>((b) => ({ ...b, type: "bookmark" }))
        .filter((n) => !qq || matchesQuery(n, qq));
      return items.length ? [{ id: "__archived", name: t("archived"), items }] : [];
    }
    if (selected === "all" ) {
      return filtered
        .filter((n) => n.type === "folder")
        .flatMap((n) => {
          const groupsLocal: { id: string; name: string; items: NavNode[] }[] = [];
          const direct = (n.children || []).filter((c) => c.type === "bookmark");
          if (direct.length)
            groupsLocal.push({
              id: n.id,
              // System folder (uncategorized) surfaces under the unified "All" name
              name: n.is_system ? t("allFolders") : n.name || "",
              items: direct,
            });
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
  }, [filtered, selected, selTag, q, archivedBookmarks, t]);

  /* ---------- bookmark actions ---------- */

  async function deleteBm(id: string) {
    const ok = await confirm({ message: t("confirmDeleteBm"), danger: true });
    if (!ok) return;
    await api.delete(`/bookmarks/${id}`);
    setSelection((prev) => {
      if (!prev.has(id)) return prev;
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    showToast(t("delete") + " ✓");
    await reload();
  }

  function notifyError(e: unknown) {
    showToast(e instanceof Error ? e.message : String(e));
  }

  async function toggleArchived(bm: NavNode) {
    try {
      await api.patch(`/bookmarks/${bm.id}`, { is_archived: !bm.is_archived });
      showToast((bm.is_archived ? t("unarchive") : t("archive")) + " ✓");
    } catch (e) {
      notifyError(e);
    }
    await reload();
  }

  function toggleSelect(id: string) {
    setSelection((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  /* ---------- batch actions (canonical shape: action + ids + payload) ---------- */

  async function runBatch(action: string, payload?: Record<string, unknown>) {
    const ids = [...selection];
    if (!ids.length) return;
    if (action === "delete") {
      const ok = await confirm({ message: `${t("confirmDeleteBm")} (${ids.length})`, danger: true });
      if (!ok) return;
    }
    const body: { action: string; ids: string[]; payload?: Record<string, unknown> } = {
      action,
      ids,
    };
    if (payload) body.payload = payload;
    try {
      await api.post("/bookmarks/batch", body);
      setSelection(new Set());
      showToast("✓");
    } catch (e) {
      notifyError(e);
    }
    await reload();
  }

  /** Select/deselect every bookmark currently visible in the content area. */
  function toggleSelectAll() {
    const visible = new Set(groups.flatMap((g) => g.items.map((b) => b.id)));
    setSelection((prev) =>
      prev.size >= visible.size && [...visible].every((id) => prev.has(id))
        ? new Set()
        : visible,
    );
  }

  /* ---------- folder drag reorder (edit mode) ---------- */

  const foldersByParent = useMemo(() => {
    const m = new Map<string | null, ManagedFolder[]>();
    for (const f of folders) {
      const list = m.get(f.parent_id) || [];
      list.push(f);
      m.set(f.parent_id, list);
    }
    for (const list of m.values()) {
      list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
    }
    return m;
  }, [folders]);

  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);

  async function onDropOnFolder(target: ManagedFolder) {
    const dragged = dragId;
    setDragId(null);
    if (!dragged || dragged === target.id) return;
    // A folder cannot land inside its own subtree
    for (let p = target.parent_id; p; p = folderById.get(p)?.parent_id ?? null) {
      if (p === dragged) return;
    }
    const siblings = (foldersByParent.get(target.parent_id) || [])
      .map((f) => f.id)
      .filter((id) => id !== dragged);
    const at = siblings.indexOf(target.id);
    siblings.splice(at === -1 ? siblings.length : at, 0, dragged);
    try {
      await api.post("/folders/reorder", { parent_id: target.parent_id, ordered_ids: siblings });
    } catch (e) {
      notifyError(e);
    }
    await reload();
  }

  async function onDeleteFolder(id: string) {
    const f = folderById.get(id);
    if (!f) return;
    const done = await deleteFolder(f);
    if (!done) return;
    if (selected === id) setSelected("all");
    showToast(t("delete") + " ✓");
    await reload();
  }

  /* ---------- render helpers ---------- */

  const folderOptions = useMemo<ComboOption[]>(
    () => folders.map((f) => ({ value: f.id, label: f.is_system ? t("allFolders") : f.name })),
    [folders, t],
  );

  const visibilityOptions: ComboOption[] = [
    { value: "public", label: `🌐 ${t("public")}` },
    { value: "unlisted", label: `🔗 ${t("unlisted")}` },
    { value: "private", label: `🔒 ${t("private")}` },
  ];

  const defaultFolderId = selected !== "all" && selected !== "archived" ? selected : "";
  // System folders (Inbox) can't be a parent category
  const defaultParentId = folderById.get(defaultFolderId)?.is_system ? "" : defaultFolderId;

  const showEdit = editMode && !!token;

  // Leaving edit mode dismisses any open category context menu
  useEffect(() => {
    if (!showEdit) setCtxMenu(null);
  }, [showEdit]);

  function editFromNode(bm: NavNode) {
    setEditing(bm);
  }

  function renderFolderRow(row: { id: string; name: string; pad: number; count: number; visibility?: string }) {
    const f = folderById.get(row.id);
    return (
      <div
        key={row.id}
        className={`folder-row${dragId === row.id ? " dragging" : ""}`}
        draggable={showEdit && !!f}
        onDragStart={showEdit && f ? () => setDragId(row.id) : undefined}
        onDragEnd={() => setDragId(null)}
        onDragOver={showEdit && dragId ? (e) => e.preventDefault() : undefined}
        onDrop={showEdit && f ? () => void onDropOnFolder(f) : undefined}
        onContextMenu={
          showEdit && f
            ? (e) => {
                e.preventDefault();
                setCtxMenu({ id: f.id, x: e.clientX, y: e.clientY });
              }
            : undefined
        }
      >
        <button
          type="button"
          className={`folder-item${selected === row.id ? " active" : ""}`}
          data-testid={`folder-node-${row.id}`}
          onClick={() => setSelected(row.id)}
        >
          {showEdit && f ? <span className="drag-handle">⠿</span> : null}
          <span style={{ paddingLeft: row.pad, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.name}
          </span>
          {token && row.visibility ? (
            <span style={{ fontSize: 10, flex: "none" }}>{visIcon(row.visibility)}</span>
          ) : null}
          <span className="folder-count">{row.count}</span>
        </button>
      </div>
    );
  }

  const batchBarVisible = showEdit && selection.size > 0;
  const ctxFolder = ctxMenu ? folderById.get(ctxMenu.id) : undefined;

  return (
    <div
      className={`public-page${showEdit ? " editing" : ""}${batchBarVisible ? " has-batch" : ""}`}
    >
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
          {token ? (
            <button
              type="button"
              className="btn btn-primary topbar-btn"
              data-testid="topbar-add"
              aria-label={t("addBm")}
              onClick={() => setAdding(true)}
            >
              <span aria-hidden>＋</span>
              <span className="tb-label">{t("addBm")}</span>
            </button>
          ) : null}
          {token ? (
            <button
              type="button"
              className={`btn topbar-btn${editMode ? " btn-soft" : ""}`}
              data-testid="topbar-edit"
              aria-label={editMode ? t("exitEdit") : t("editMode")}
              onClick={() => setEditMode((v) => !v)}
            >
              <span aria-hidden>{editMode ? "✓" : "✎"}</span>
              <span className="tb-label">{editMode ? t("exitEdit") : t("editMode")}</span>
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
            <UserMenu
              username={user?.username}
              onOpenSettings={(tab) => setSettings({ open: true, tab })}
              onLogout={logout}
            />
          ) : (
            <button
              type="button"
              className="btn btn-primary topbar-btn"
              data-testid="topbar-login"
              onClick={() => setLoginOpen(true)}
            >
              {t("login")}
            </button>
          )}
        </div>
      </header>

      {/* Mobile: horizontal category chips (prototype narrow layout) */}
      <div className="scroll-chips public-folder-chips" role="navigation" aria-label={t("folders")}>
        <button
          type="button"
          className={`chip${selected === "all" ? " active" : ""}`}
          onClick={() => setSelected("all")}
        >
          {t("allFolders")}
          <span className="chip-count">{totalCount}</span>
        </button>
        {token && archivedBookmarks.length > 0 ? (
          <button
            type="button"
            className={`chip${selected === "archived" ? " active" : ""}`}
            onClick={() => setSelected("archived")}
          >
            📦 {t("archived")}
            <span className="chip-count">{archivedBookmarks.length}</span>
          </button>
        ) : null}
        {folderRows.map((n) => (
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
        {sidebarTags.slice(0, 6).map((tg) => (
          <button
            key={`tag-${tg.name}`}
            type="button"
            className={`chip${selTag === tg.name ? " active" : ""}`}
            onClick={() => setSelTag((cur) => (cur === tg.name ? null : tg.name))}
          >
            #{tg.name}
          </button>
        ))}
      </div>

      <div className="public-body">
        <aside className="public-aside">
          <div className="section-label" style={{ padding: "0 12px 10px" }}>
            {t("folders")}
          </div>
          <div className="stack" style={{ gap: 2 }} data-testid="folder-tree">
            <button
              type="button"
              className={`folder-item${selected === "all" ? " active" : ""}`}
              onClick={() => setSelected("all")}
            >
              <span>{t("allFolders")}</span>
              <span className="folder-count">{totalCount}</span>
            </button>
            {folderRows.map((row) => renderFolderRow(row))}
            {token && (archivedBookmarks.length > 0 || showEdit) ? (
              <button
                type="button"
                className={`folder-item${selected === "archived" ? " active" : ""}`}
                data-testid="folder-archived"
                onClick={() => setSelected("archived")}
              >
                <span>📦 {t("archived")}</span>
                <span className="folder-count">{archivedBookmarks.length}</span>
              </button>
            ) : null}
            {showEdit ? (
              <button
                type="button"
                className="btn btn-soft"
                style={{ margin: "10px 12px 0" }}
                data-testid="new-folder"
                onClick={() => setFolderModal({ open: true, folder: null })}
              >
                + {t("newCategory")}
              </button>
            ) : null}
          </div>
          {sidebarTags.length ? (
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
                {sidebarTags.map((tg) => (
                  <span key={tg.name} className="tag-edit-wrap">
                    <button
                      type="button"
                      className={`tag-chip${selTag === tg.name ? " active" : ""}`}
                      style={{ cursor: "pointer", border: "none" }}
                      onClick={() => setSelTag((cur) => (cur === tg.name ? null : tg.name))}
                    >
                      #{tg.name}
                    </button>
                    {showEdit && tg.id ? (
                      <button
                        type="button"
                        className="btn-icon tag-edit-btn"
                        title={t("editTag")}
                        onClick={() => setTagModal({ id: tg.id!, name: tg.name })}
                      >
                        ✎
                      </button>
                    ) : null}
                  </span>
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
                <div className="grid-cards" data-testid="bookmark-cards">
                  {g.items.map((bm) => (
                    <BookmarkCard
                      key={bm.id}
                      bm={{
                        id: bm.id,
                        title: bm.title || "",
                        url: bm.url || "",
                        description: bm.description,
                        icon: bm.icon,
                        visibility: token ? bm.visibility : undefined,
                        is_archived: bm.is_archived,
                        tags: bm.tags,
                      }}
                      editMode={showEdit}
                      linkTitleOnly={false}
                      onArchive={showEdit ? () => void toggleArchived(bm) : undefined}
                      onEdit={showEdit ? () => editFromNode(bm) : undefined}
                      onDelete={showEdit ? () => void deleteBm(bm.id) : undefined}
                      selected={selection.has(bm.id)}
                      onSelectToggle={showEdit ? () => toggleSelect(bm.id) : undefined}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      <footer className="foot-note">MarkHub · {t("footNote")}</footer>

      {/* Batch action bar (edit mode, with selection) */}
      {batchBarVisible ? (
        <div className="batch-bar" data-testid="batch-bar">
          <span className="batch-count">
            {selection.size} {t("selectedSuffix")}
          </span>
          <button type="button" className="btn" onClick={toggleSelectAll}>
            {t("selectAll")}
          </button>
          <div style={{ width: 170 }}>
            <Combobox
              value=""
              options={folderOptions}
              onChange={(v) => void runBatch("move", { folder_id: v })}
              placeholder={t("moveToPh")}
            />
          </div>
          <div style={{ width: 150 }}>
            <Combobox
              value=""
              options={visibilityOptions}
              onChange={(v) => void runBatch("set_visibility", { visibility: v })}
              placeholder={t("setVisibilityPh")}
            />
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => void runBatch("set_archived", { is_archived: true })}
          >
            📦 {t("archive")}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void runBatch("delete")}>
            {t("delete")}
          </button>
          <button type="button" className="btn" onClick={() => setSelection(new Set())}>
            {t("clearSelection")}
          </button>
        </div>
      ) : null}

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

      <FolderModal
        open={folderModal.open}
        api={api}
        folder={folderModal.folder}
        folders={folders}
        defaultParentId={defaultParentId}
        onClose={() => setFolderModal({ open: false, folder: null })}
        onSaved={() => {
          setFolderModal({ open: false, folder: null });
          showToast(t("save") + " ✓");
          void reload();
        }}
        onNotice={showToast}
      />

      <TagModal
        open={!!tagModal}
        api={api}
        tag={tagModal}
        usage={tagModal ? tagUsage.get(tagModal.name) || 0 : 0}
        onClose={() => setTagModal(null)}
        onChanged={() => {
          setTagModal(null);
          setSelTag(null);
          showToast("✓");
          void reload();
        }}
        onNotice={showToast}
      />

      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />

      <SettingsModal
        open={settings.open}
        initialTab={settings.tab}
        forceAccount={forcePw}
        onClose={() => {
          setSettings((s) => ({ ...s, open: false }));
          // Imports / credential changes may have altered data
          void reload();
        }}
      />

      {showEdit && ctxMenu && ctxFolder ? (
        <FolderContextMenu
          name={ctxFolder.name}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={closeCtxMenu}
          onEdit={() => {
            setCtxMenu(null);
            setFolderModal({ open: true, folder: ctxFolder });
          }}
          onDelete={() => {
            setCtxMenu(null);
            void onDeleteFolder(ctxFolder.id);
          }}
        />
      ) : null}
      {confirmElement}
      {deleteFolderElement}
      <Toast message={toast} />
    </div>
  );
}
