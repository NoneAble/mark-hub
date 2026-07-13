import { FormEvent, useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";

export function AdminBookmarks() {
  const { api } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<any[]>([]);
  const [folders, setFolders] = useState<any[]>([]);
  const [tags, setTags] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<any | null>(null);
  const [form, setForm] = useState({
    title: "",
    url: "",
    folder_id: "",
    visibility: "private",
    is_favorite: false,
    is_archived: false,
    tags: [] as string[],
  });
  const [error, setError] = useState("");
  const [batchAction, setBatchAction] = useState("delete");
  const [batchFolder, setBatchFolder] = useState("");

  async function load() {
    const [bm, fd, tg] = await Promise.all([
      api.get<{ items: any[] }>(`/bookmarks?q=${encodeURIComponent(q)}&limit=200`),
      api.get<{ items: any[] }>("/folders"),
      api.get<{ items: any[] }>("/tags"),
    ]);
    setItems(bm.items);
    setFolders(fd.items);
    setTags(tg.items);
    if (!form.folder_id && fd.items[0]) {
      setForm((f) => ({
        ...f,
        folder_id: fd.items.find((x) => x.is_system)?.id || fd.items[0].id,
      }));
    }
  }

  function toggleFormTag(tagName: string) {
    setForm((f) => {
      const has = f.tags.includes(tagName);
      return {
        ...f,
        tags: has ? f.tags.filter((x) => x !== tagName) : [...f.tags, tagName],
      };
    });
  }

  function toggleEditTag(tagName: string) {
    if (!editing) return;
    const current: string[] = Array.isArray(editing.tags)
      ? editing.tags.map((x: any) => (typeof x === "string" ? x : x.name)).filter(Boolean)
      : [];
    const has = current.includes(tagName);
    const next = has ? current.filter((x) => x !== tagName) : [...current, tagName];
    setEditing({ ...editing, tags: next });
  }

  useEffect(() => {
    void load().catch((e) => setError(String(e.message || e)));
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    await api.post("/bookmarks", {
      title: form.title,
      url: form.url,
      folder_id: form.folder_id,
      visibility: form.visibility,
      is_favorite: form.is_favorite,
      is_archived: form.is_archived,
      tags: form.tags,
    });
    setForm((f) => ({ ...f, title: "", url: "", tags: [] }));
    await load();
  }

  async function onDelete(id: string) {
    await api.delete(`/bookmarks/${id}`);
    await load();
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const tagNames: string[] = Array.isArray(editing.tags)
      ? editing.tags.map((x: any) => (typeof x === "string" ? x : x.name)).filter(Boolean)
      : [];
    await api.patch(`/bookmarks/${editing.id}`, {
      title: editing.title,
      url: editing.url,
      folder_id: editing.folder_id,
      visibility: editing.visibility,
      is_favorite: editing.is_favorite,
      is_archived: editing.is_archived,
      description: editing.description,
      tags: tagNames,
    });
    setEditing(null);
    await load();
  }

  async function toggleFavorite(b: any) {
    await api.patch(`/bookmarks/${b.id}`, { is_favorite: !b.is_favorite });
    await load();
  }

  async function toggleArchived(b: any) {
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
    // Canonical shape: action + ids + nested payload (R4-F014 / OpenAPI)
    const body: {
      action: string;
      ids: string[];
      payload?: Record<string, unknown>;
    } = { action: batchAction, ids };
    if (batchAction === "move") {
      body.payload = { folder_id: batchFolder || form.folder_id };
    } else if (batchAction === "set_visibility") {
      body.payload = { visibility: "public" };
    } else if (batchAction === "set_archived") {
      body.payload = { is_archived: true };
    }
    await api.post("/bookmarks/batch", body);
    setSelected(new Set());
    await load();
  }

  return (
    <div>
      <h1 className="page-title">{t("bookmarks")}</h1>
      {error ? <div className="error">{error}</div> : null}
      <form className="card row wrap" onSubmit={onCreate} style={{ marginBottom: 16 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 120 }}
          placeholder={t("title")}
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
        <input
          className="input"
          style={{ flex: 2, minWidth: 160 }}
          placeholder={t("url")}
          value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
          required
        />
        <select
          className="input"
          style={{ width: 160 }}
          value={form.folder_id}
          onChange={(e) => setForm({ ...form, folder_id: e.target.value })}
        >
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <select
          className="input"
          style={{ width: 120 }}
          value={form.visibility}
          onChange={(e) => setForm({ ...form, visibility: e.target.value })}
        >
          <option value="private">{t("private")}</option>
          <option value="unlisted">{t("unlisted")}</option>
          <option value="public">{t("public")}</option>
        </select>
        <button className="btn btn-primary" type="submit">
          {t("add")}
        </button>
        {tags.length ? (
          <div className="row wrap" style={{ width: "100%", gap: 6 }}>
            <span className="muted">{t("tags")}:</span>
            {tags.map((tg) => (
              <label key={tg.id} className="row" style={{ gap: 4 }}>
                <input
                  type="checkbox"
                  checked={form.tags.includes(tg.name)}
                  onChange={() => toggleFormTag(tg.name)}
                />
                {tg.name}
              </label>
            ))}
          </div>
        ) : null}
      </form>

      <div className="row wrap" style={{ marginBottom: 12, gap: 8 }}>
        <input
          className="input"
          style={{ maxWidth: 320, flex: 1 }}
          placeholder={t("search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load()}
        />
        <button className="btn" type="button" onClick={() => void load()}>
          {t("search")}
        </button>
        <select
          className="input"
          style={{ width: 140 }}
          value={batchAction}
          onChange={(e) => setBatchAction(e.target.value)}
        >
          <option value="delete">{t("delete")}</option>
          <option value="move">{t("move")}</option>
          <option value="set_visibility">{t("visibility")}</option>
          <option value="set_archived">{t("archive")}</option>
        </select>
        {batchAction === "move" ? (
          <select
            className="input"
            style={{ width: 140 }}
            value={batchFolder}
            onChange={(e) => setBatchFolder(e.target.value)}
          >
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        ) : null}
        <button className="btn" type="button" disabled={!selected.size} onClick={() => void runBatch()}>
          {t("batch")} ({selected.size})
        </button>
      </div>

      {editing ? (
        <form className="card stack" onSubmit={onSaveEdit} style={{ marginBottom: 16 }}>
          <h3>{t("edit")}</h3>
          <input
            className="input"
            value={editing.title}
            onChange={(e) => setEditing({ ...editing, title: e.target.value })}
          />
          <input
            className="input"
            value={editing.url}
            onChange={(e) => setEditing({ ...editing, url: e.target.value })}
          />
          <select
            className="input"
            value={editing.folder_id}
            onChange={(e) => setEditing({ ...editing, folder_id: e.target.value })}
          >
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <select
            className="input"
            value={editing.visibility}
            onChange={(e) => setEditing({ ...editing, visibility: e.target.value })}
          >
            <option value="private">{t("private")}</option>
            <option value="unlisted">{t("unlisted")}</option>
            <option value="public">{t("public")}</option>
          </select>
          <label className="row">
            <input
              type="checkbox"
              checked={!!editing.is_favorite}
              onChange={(e) => setEditing({ ...editing, is_favorite: e.target.checked })}
            />
            {t("favorite")}
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={!!editing.is_archived}
              onChange={(e) => setEditing({ ...editing, is_archived: e.target.checked })}
            />
            {t("archive")}
          </label>
          {tags.length ? (
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="muted">{t("tags")}:</span>
              {tags.map((tg) => {
                const current: string[] = Array.isArray(editing.tags)
                  ? editing.tags
                      .map((x: any) => (typeof x === "string" ? x : x.name))
                      .filter(Boolean)
                  : [];
                return (
                  <label key={tg.id} className="row" style={{ gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={current.includes(tg.name)}
                      onChange={() => toggleEditTag(tg.name)}
                    />
                    {tg.name}
                  </label>
                );
              })}
            </div>
          ) : null}
          <div className="row">
            <button className="btn btn-primary" type="submit">
              {t("save")}
            </button>
            <button className="btn" type="button" onClick={() => setEditing(null)}>
              {t("cancel")}
            </button>
          </div>
        </form>
      ) : null}

      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={items.length > 0 && selected.size === items.length}
                  onChange={toggleSelectAll}
                />
              </th>
              <th>{t("title")}</th>
              <th>{t("url")}</th>
              <th>{t("visibility")}</th>
              <th />
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
                  {b.is_favorite ? "★ " : ""}
                  {b.is_archived ? "📦 " : ""}
                  {b.title}
                </td>
                <td>
                  <a href={b.url} target="_blank" rel="noreferrer">
                    {b.url}
                  </a>
                </td>
                <td>
                  <span className="badge">{b.visibility}</span>
                </td>
                <td className="row wrap" style={{ gap: 4 }}>
                  <button className="btn" type="button" onClick={() => setEditing({ ...b })}>
                    {t("edit")}
                  </button>
                  <button className="btn" type="button" onClick={() => void toggleFavorite(b)}>
                    {b.is_favorite ? "★" : "☆"}
                  </button>
                  <button className="btn" type="button" onClick={() => void toggleArchived(b)}>
                    {t("archive")}
                  </button>
                  <button className="btn" type="button" onClick={() => void onDelete(b.id)}>
                    {t("delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tags.length ? (
        <p className="muted" style={{ marginTop: 12 }}>
          {t("tags")}: {tags.map((tg) => tg.name).join(", ")}
        </p>
      ) : null}
    </div>
  );
}
