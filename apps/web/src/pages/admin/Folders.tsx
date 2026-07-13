import { FormEvent, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";

type Folder = {
  id: string;
  name: string;
  parent_id: string | null;
  visibility: string;
  is_system: boolean;
  sort_order: number;
};

export function AdminFolders() {
  const { api } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<Folder[]>([]);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [parentId, setParentId] = useState("");
  const [deleteMode, setDeleteMode] = useState("move_to_inbox");
  const [dragId, setDragId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Folder | null>(null);

  async function load() {
    const r = await api.get<{ items: Folder[] }>("/folders");
    setItems(r.items);
  }

  useEffect(() => {
    void load();
  }, []);

  const tree = useMemo(() => {
    const byParent = new Map<string | null, Folder[]>();
    for (const f of items) {
      const k = f.parent_id;
      const list = byParent.get(k) || [];
      list.push(f);
      byParent.set(k, list);
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    }
    return byParent;
  }, [items]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    await api.post("/folders", {
      name,
      visibility,
      parent_id: parentId || null,
    });
    setName("");
    await load();
  }

  async function onDelete(id: string, isSystem: boolean) {
    if (isSystem) return;
    await api.delete(`/folders/${id}?mode=${deleteMode}`);
    await load();
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const body: Record<string, unknown> = { name: editing.name };
    // System folders: rename only (KD-35)
    if (!editing.is_system) {
      body.visibility = editing.visibility;
      body.parent_id = editing.parent_id;
    }
    await api.patch(`/folders/${editing.id}`, body);
    setEditing(null);
    await load();
  }

  async function onDrop(targetParent: string | null) {
    if (!dragId) return;
    const siblings = (tree.get(targetParent) || []).map((f) => f.id).filter((id) => id !== dragId);
    siblings.push(dragId);
    await api.post("/folders/reorder", { parent_id: targetParent, ordered_ids: siblings });
    setDragId(null);
    await load();
  }

  function renderNodes(parent: string | null, depth = 0): React.ReactNode {
    const kids = tree.get(parent) || [];
    return kids.map((f) => (
      <div key={f.id}>
        <div
          className="row"
          draggable={!f.is_system}
          onDragStart={() => setDragId(f.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => void onDrop(f.parent_id)}
          style={{
            padding: "8px 12px",
            paddingLeft: 12 + depth * 16,
            borderBottom: "1px solid var(--border)",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ flex: 1, minWidth: 120 }}>
            {f.is_system ? "📥 " : "📁 "}
            {f.name}
          </span>
          <span className="badge">{f.visibility}</span>
          <button className="btn" type="button" onClick={() => setEditing({ ...f })}>
            {t("edit")}
          </button>
          <button
            className="btn"
            disabled={f.is_system}
            type="button"
            onClick={() => void onDelete(f.id, f.is_system)}
          >
            {t("delete")}
          </button>
        </div>
        {renderNodes(f.id, depth + 1)}
      </div>
    ));
  }

  return (
    <div>
      <h1 className="page-title">{t("folders")}</h1>
      <form className="card row wrap" onSubmit={onCreate} style={{ marginBottom: 16, gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 140 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("title")}
          required
        />
        <select
          className="input"
          style={{ width: 160 }}
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
        >
          <option value="">{t("root")}</option>
          {items.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <select
          className="input"
          style={{ width: 140 }}
          value={visibility}
          onChange={(e) => setVisibility(e.target.value)}
        >
          <option value="private">{t("private")}</option>
          <option value="unlisted">{t("unlisted")}</option>
          <option value="public">{t("public")}</option>
        </select>
        <button className="btn btn-primary" type="submit">
          {t("add")}
        </button>
      </form>

      <div className="row wrap" style={{ marginBottom: 12, gap: 8 }}>
        <label className="muted">{t("deleteMode")}</label>
        <select
          className="input"
          style={{ width: 200 }}
          value={deleteMode}
          onChange={(e) => setDeleteMode(e.target.value)}
        >
          <option value="move_to_parent">move_to_parent</option>
          <option value="move_to_inbox">move_to_inbox</option>
          <option value="cascade_soft_delete">cascade_soft_delete</option>
        </select>
      </div>

      {editing ? (
        <form className="card row wrap" onSubmit={onSaveEdit} style={{ marginBottom: 16, gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 140 }}
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            required
          />
          {!editing.is_system ? (
            <>
              <select
                className="input"
                style={{ width: 160 }}
                value={editing.parent_id || ""}
                onChange={(e) =>
                  setEditing({ ...editing, parent_id: e.target.value || null })
                }
              >
                <option value="">{t("root")}</option>
                {items
                  .filter((x) => x.id !== editing.id)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
              <select
                className="input"
                style={{ width: 140 }}
                value={editing.visibility}
                onChange={(e) => setEditing({ ...editing, visibility: e.target.value })}
              >
                <option value="private">{t("private")}</option>
                <option value="unlisted">{t("unlisted")}</option>
                <option value="public">{t("public")}</option>
              </select>
            </>
          ) : (
            <span className="muted">System folder: rename only</span>
          )}
          <button className="btn btn-primary" type="submit">
            {t("save")}
          </button>
          <button className="btn" type="button" onClick={() => setEditing(null)}>
            {t("cancel")}
          </button>
        </form>
      ) : null}

      <div
        className="card"
        style={{ padding: 0 }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => void onDrop(null)}
      >
        {renderNodes(null)}
      </div>
    </div>
  );
}
