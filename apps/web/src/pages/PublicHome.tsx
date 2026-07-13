import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../i18n";
import { faviconOf, hostnameOf } from "@markhub/ui";

type NavNode = {
  type: "folder" | "bookmark";
  id: string;
  name?: string;
  title?: string;
  url?: string;
  description?: string | null;
  visibility?: string;
  children?: NavNode[];
};

export function PublicHome() {
  const { api, token } = useAuth();
  const { t } = useI18n();
  const [tree, setTree] = useState<NavNode[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");

  async function reload() {
    const r = await api.get<{ tree: NavNode[] }>("/nav/public");
    setTree(r.tree || []);
  }

  useEffect(() => {
    void reload();
  }, [api]);

  function filterNodes(nodes: NavNode[]): NavNode[] {
    if (!q.trim()) return nodes;
    const qq = q.toLowerCase();
    return nodes
      .map((n) => {
        if (n.type === "bookmark") {
          const hit =
            (n.title || "").toLowerCase().includes(qq) ||
            (n.url || "").toLowerCase().includes(qq);
          return hit ? n : null;
        }
        const kids = filterNodes(n.children || []);
        if (kids.length || (n.name || "").toLowerCase().includes(qq)) {
          return { ...n, children: kids };
        }
        return null;
      })
      .filter(Boolean) as NavNode[];
  }

  const shown = filterNodes(tree);

  async function onSaveBookmark(id: string, patch: Record<string, unknown>) {
    await api.patch(`/bookmarks/${id}`, patch);
    setMsg("");
    await reload();
  }

  async function onDeleteBookmark(id: string) {
    if (!confirm(t("delete") + "?")) return;
    await api.delete(`/bookmarks/${id}`);
    await reload();
  }

  async function onSaveFolder(id: string, patch: Record<string, unknown>) {
    await api.patch(`/folders/${id}`, patch);
    await reload();
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 20px 60px" }}>
      <header className="row" style={{ justifyContent: "space-between", marginBottom: 28 }}>
        <div className="row" style={{ gap: 10 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "var(--accent)",
            }}
          />
          <div>
            <div style={{ fontWeight: 700, fontSize: 18 }}>{t("appName")}</div>
            <div className="muted">{t("publicNav")}</div>
          </div>
        </div>
        <div className="row">
          <input
            className="input"
            style={{ width: 220 }}
            placeholder={t("search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {token ? (
            <>
              <button className="btn" type="button" onClick={() => setEditMode((v) => !v)}>
                {editMode ? t("done") : t("edit")}
              </button>
              <Link className="btn" to="/app">
                {t("workbench")}
              </Link>
              <Link className="btn" to="/admin">
                {t("admin")}
              </Link>
            </>
          ) : (
            <Link className="btn btn-primary" to="/admin/login">
              {t("login")}
            </Link>
          )}
        </div>
      </header>

      {msg ? <div className="error">{msg}</div> : null}

      {shown.length === 0 ? (
        <div className="card muted">{t("noPublicBookmarks")}</div>
      ) : (
        <div className="stack" style={{ gap: 28 }}>
          {shown.map((n) => (
            <Section
              key={n.id}
              node={n}
              editMode={editMode && !!token}
              onSaveBookmark={onSaveBookmark}
              onDeleteBookmark={onDeleteBookmark}
              onSaveFolder={onSaveFolder}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Section({
  node,
  editMode,
  onSaveBookmark,
  onDeleteBookmark,
  onSaveFolder,
}: {
  node: NavNode;
  editMode: boolean;
  onSaveBookmark: (id: string, patch: Record<string, unknown>) => Promise<void>;
  onDeleteBookmark: (id: string) => Promise<void>;
  onSaveFolder: (id: string, patch: Record<string, unknown>) => Promise<void>;
}) {
  if (node.type === "bookmark") {
    return (
      <BookmarkCard
        node={node}
        editMode={editMode}
        onSave={onSaveBookmark}
        onDelete={onDeleteBookmark}
      />
    );
  }
  const folders = (node.children || []).filter((c) => c.type === "folder");
  const bookmarks = (node.children || []).filter((c) => c.type === "bookmark");
  return (
    <section>
      <FolderHeader node={node} editMode={editMode} onSave={onSaveFolder} />
      {bookmarks.length ? (
        <div className="grid-cards" style={{ marginBottom: 16 }}>
          {bookmarks.map((b) => (
            <BookmarkCard
              key={b.id}
              node={b}
              editMode={editMode}
              onSave={onSaveBookmark}
              onDelete={onDeleteBookmark}
            />
          ))}
        </div>
      ) : null}
      {folders.map((f) => (
        <Section
          key={f.id}
          node={f}
          editMode={editMode}
          onSaveBookmark={onSaveBookmark}
          onDeleteBookmark={onDeleteBookmark}
          onSaveFolder={onSaveFolder}
        />
      ))}
    </section>
  );
}

function FolderHeader({
  node,
  editMode,
  onSave,
}: {
  node: NavNode;
  editMode: boolean;
  onSave: (id: string, patch: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.name || "");

  useEffect(() => setName(node.name || ""), [node.name]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    await onSave(node.id, { name });
    setEditing(false);
  }

  if (editMode && editing) {
    return (
      <form className="row" onSubmit={submit} style={{ marginBottom: 12 }}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-primary" type="submit">
          {t("save")}
        </button>
        <button className="btn" type="button" onClick={() => setEditing(false)}>
          {t("cancel")}
        </button>
      </form>
    );
  }

  return (
    <div className="row" style={{ marginBottom: 12, gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{node.name}</h2>
      {editMode ? (
        <button className="btn" type="button" onClick={() => setEditing(true)}>
          {t("edit")}
        </button>
      ) : null}
    </div>
  );
}

function BookmarkCard({
  node,
  editMode,
  onSave,
  onDelete,
}: {
  node: NavNode;
  editMode: boolean;
  onSave: (id: string, patch: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(node.title || "");
  const [url, setUrl] = useState(node.url || "");
  const [description, setDescription] = useState(node.description || "");

  useEffect(() => {
    setTitle(node.title || "");
    setUrl(node.url || "");
    setDescription(node.description || "");
  }, [node]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    await onSave(node.id, { title, url, description });
    setEditing(false);
  }

  if (editMode && editing) {
    return (
      <form className="bm-card stack" onSubmit={submit}>
        <input
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("title")}
        />
        <input
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("url")}
        />
        <input
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("description")}
        />
        <div className="row">
          <button className="btn btn-primary" type="submit">
            {t("save")}
          </button>
          <button className="btn" type="button" onClick={() => setEditing(false)}>
            {t("cancel")}
          </button>
          <button className="btn" type="button" onClick={() => void onDelete(node.id)}>
            {t("delete")}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="bm-card stack">
      <a
        href={node.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          if (editMode) e.preventDefault();
        }}
        style={{ textDecoration: "none", color: "inherit" }}
      >
        <div className="row" style={{ gap: 8 }}>
          <img src={faviconOf(node.url || "")} width={18} height={18} alt="" />
          <strong style={{ fontSize: 14 }}>{node.title}</strong>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {hostnameOf(node.url || "")}
        </div>
        {node.description ? (
          <div className="muted" style={{ fontSize: 12 }}>
            {node.description}
          </div>
        ) : null}
      </a>
      {editMode ? (
        <div className="row">
          <span className="badge">{t("editMode")}</span>
          <button className="btn" type="button" onClick={() => setEditing(true)}>
            {t("edit")}
          </button>
          <button className="btn" type="button" onClick={() => void onDelete(node.id)}>
            {t("delete")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
