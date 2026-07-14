import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../i18n";
import { BookmarkCard } from "../components/BookmarkCard";
import { LogoMark, Modal, SearchField, Toast, useToast } from "../components/ui";
import { currentTheme, initThemeFromStorage, toggleTheme } from "../lib/theme";

type NavNode = {
  type: "folder" | "bookmark";
  id: string;
  name?: string;
  title?: string;
  url?: string;
  description?: string | null;
  visibility?: string;
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

export function PublicHome() {
  const { api, token } = useAuth();
  const { t, lang, toggleLang } = useI18n();
  const { toast, showToast } = useToast();
  const [tree, setTree] = useState<NavNode[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | "all">("all");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [editing, setEditing] = useState<NavNode | null>(null);
  const [draft, setDraft] = useState({ title: "", url: "", description: "" });
  const [adding, setAdding] = useState(false);

  async function reload() {
    const r = await api.get<{ tree: NavNode[] }>("/nav/public");
    setTree(r.tree || []);
  }

  useEffect(() => {
    initThemeFromStorage();
    setTheme(currentTheme());
    void reload();
  }, [api]);

  const folders = useMemo(() => tree.filter((n) => n.type === "folder"), [tree]);
  const allTags = useMemo(() => collectTags(tree), [tree]);

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
    return filterTree(base, qq);
  }, [tree, selected, q]);

  const groups = useMemo(() => {
    // When viewing all: each top-level folder's direct bookmarks + each nested folder as a group
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

  function openEdit(bm: NavNode) {
    setEditing(bm);
    setDraft({
      title: bm.title || "",
      url: bm.url || "",
      description: bm.description || "",
    });
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    await api.patch(`/bookmarks/${editing.id}`, draft);
    setEditing(null);
    showToast(t("save"));
    await reload();
  }

  async function deleteBm(id: string) {
    if (!confirm(t("delete") + "?")) return;
    await api.delete(`/bookmarks/${id}`);
    showToast(t("delete"));
    await reload();
  }

  async function addBookmark(e: FormEvent) {
    e.preventDefault();
    await api.post("/bookmarks", {
      title: draft.title,
      url: draft.url,
      description: draft.description,
      visibility: "public",
    });
    setAdding(false);
    setDraft({ title: "", url: "", description: "" });
    showToast(t("addBm"));
    await reload();
  }

  const folderNav = useMemo(() => {
    const items: { id: string | "all"; name: string; count: number; pad: number }[] = [
      {
        id: "all",
        name: t("allFolders"),
        count: folders.reduce((n, f) => n + countBookmarks(f), 0),
        pad: 0,
      },
    ];
    for (const f of folders) {
      items.push({ id: f.id, name: f.name || "", count: countBookmarks(f), pad: 0 });
      for (const c of f.children || []) {
        if (c.type === "folder") {
          items.push({ id: c.id, name: c.name || "", count: countBookmarks(c), pad: 14 });
        }
      }
    }
    return items;
  }, [folders, t]);

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
        />
        <div className="public-actions">
          {token && editMode ? (
            <button
              type="button"
              className="btn btn-primary topbar-btn"
              onClick={() => {
                setDraft({ title: "", url: "", description: "" });
                setAdding(true);
              }}
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
          <button
            type="button"
            className="btn topbar-btn"
            onClick={toggleLang}
          >
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

      {/* Mobile: horizontal folder chips (prototype narrow layout) */}
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
            className="chip"
            onClick={() => setQ(tg)}
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
                    className="tag-chip"
                    style={{ cursor: "pointer", border: "none" }}
                    onClick={() => setQ(tg)}
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
                    {g.items.length} {lang === "zh" ? "项" : "items"}
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
                        visibility: bm.visibility,
                        tags: bm.tags,
                      }}
                      editMode={editMode && !!token}
                      linkTitleOnly={false}
                      onEdit={editMode && token ? () => openEdit(bm) : undefined}
                      onDelete={editMode && token ? () => void deleteBm(bm.id) : undefined}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      <footer className="foot-note">
        MarkHub · {t("footNote")}
      </footer>

      <Modal
        open={!!editing}
        title={t("editBm")}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              {t("cancel")}
            </button>
            <button type="submit" form="edit-bm-form" className="btn btn-primary">
              {t("save")}
            </button>
          </>
        }
      >
        <form id="edit-bm-form" className="stack" onSubmit={(e) => void saveEdit(e)}>
          <label className="field">
            {t("title")}
            <input
              className="input"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label className="field">
            {t("url")}
            <input
              className="input input-mono"
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
          </label>
          <label className="field">
            {t("description")}
            <input
              className="input"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
        </form>
      </Modal>

      <Modal
        open={adding}
        title={t("newBm")}
        onClose={() => setAdding(false)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              {t("cancel")}
            </button>
            <button type="submit" form="add-bm-form" className="btn btn-primary">
              {t("save")}
            </button>
          </>
        }
      >
        <form id="add-bm-form" className="stack" onSubmit={(e) => void addBookmark(e)}>
          <label className="field">
            {t("title")}
            <input
              className="input"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              required
            />
          </label>
          <label className="field">
            {t("url")}
            <input
              className="input input-mono"
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              required
            />
          </label>
          <label className="field">
            {t("description")}
            <input
              className="input"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
        </form>
      </Modal>

      <Toast message={toast} />
    </div>
  );
}
