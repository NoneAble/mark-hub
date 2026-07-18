import { FormEvent, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";
import { EmptyState, Modal, PageHeader, Toast, useToast } from "../../components/ui";
import { Combobox, Segmented, useConfirm, type ComboOption } from "../../components/form";
import { visIcon } from "../../lib/colors";

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
  const { toast, showToast } = useToast();
  const { confirm, confirmElement } = useConfirm();
  const [items, setItems] = useState<Folder[]>([]);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [parentId, setParentId] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Folder | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const [r, bm] = await Promise.all([
      api.get<{ items: Folder[] }>("/folders"),
      api.get<{ items: { folder_id: string }[] }>("/bookmarks?limit=1000"),
    ]);
    setItems(r.items);
    const m = new Map<string, number>();
    for (const b of bm.items) m.set(b.folder_id, (m.get(b.folder_id) || 0) + 1);
    setCounts(m);
  }

  useEffect(() => {
    void load().catch((e) => setError(String(e.message || e)));
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

  const parentOptions = useMemo<ComboOption[]>(
    () => [
      { value: "", label: t("root") },
      ...items.filter((f) => !f.is_system).map((f) => ({ value: f.id, label: f.name })),
    ],
    [items, t],
  );

  const visSegOptions = [
    { value: "private", label: `🔒 ${t("private")}` },
    { value: "unlisted", label: `🔗 ${t("unlisted")}` },
    { value: "public", label: `🌐 ${t("public")}` },
  ];

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api.post("/folders", { name, visibility, parent_id: parentId || null });
      setName("");
      showToast(t("newCategory") + " ✓");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDelete(f: Folder) {
    if (f.is_system) return;
    let mode = "move_to_inbox";
    const ok = await confirm({
      title: t("confirmDeleteFolder"),
      message: `${t("confirmDeleteFolder")}「${f.name}」？`,
      danger: true,
      body: (
        <DeleteModePicker
          onPick={(m) => {
            mode = m;
          }}
        />
      ),
    });
    if (!ok) return;
    await api.delete(`/folders/${f.id}?mode=${mode}`);
    showToast(t("delete") + " ✓");
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
    showToast(t("save") + " ✓");
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
          className={`manage-row${dragId === f.id ? " dragging" : ""}`}
          draggable={!f.is_system}
          onDragStart={() => setDragId(f.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => void onDrop(f.parent_id)}
          style={{ paddingLeft: 14 + depth * 20 }}
        >
          {!f.is_system ? <span className="drag-handle">⠿</span> : <span style={{ width: 13 }} />}
          <span className="manage-name">
            {f.is_system ? "📥" : "▣"} {f.name}
            {f.is_system ? (
              <span className="badge badge-accent">{t("systemCategory")}</span>
            ) : null}
          </span>
          <span className="badge">
            {visIcon(f.visibility)} {t(f.visibility as "private" | "unlisted" | "public")}
          </span>
          <span className="muted-sm">
            {counts.get(f.id) || 0} {t("itemsUnit")}
          </span>
          <div className="manage-actions">
            <button className="btn-icon" type="button" title={t("edit")} onClick={() => setEditing({ ...f })}>
              ✎
            </button>
            <button
              className="btn-icon"
              disabled={f.is_system}
              type="button"
              title={t("delete")}
              onClick={() => void onDelete(f)}
            >
              ✕
            </button>
          </div>
        </div>
        {renderNodes(f.id, depth + 1)}
      </div>
    ));
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <PageHeader title={t("folderManage")} />
      {error ? <div className="error" style={{ marginBottom: 10 }}>{error}</div> : null}

      <form className="card" onSubmit={(e) => void onCreate(e)} style={{ marginBottom: 16 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 150 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("newCategory")}
            required
          />
          <div style={{ width: 190, flex: "none" }}>
            <Combobox
              value={parentId}
              options={parentOptions}
              onChange={setParentId}
              placeholder={t("parentCategory")}
            />
          </div>
          <Segmented value={visibility} options={visSegOptions} onChange={setVisibility} />
          <button className="btn btn-primary" type="submit">
            {t("add")}
          </button>
        </div>
      </form>

      <div
        className="card card-flush"
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => void onDrop(null)}
      >
        {items.length ? renderNodes(null) : <EmptyState>{t("empty")}</EmptyState>}
      </div>

      <Modal
        open={!!editing}
        title={t("edit")}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              {t("cancel")}
            </button>
            <button type="submit" form="folder-edit" className="btn btn-primary">
              {t("save")}
            </button>
          </>
        }
      >
        {editing ? (
          <form id="folder-edit" className="stack" onSubmit={(e) => void onSaveEdit(e)}>
            <label className="field">
              {t("title")}
              <input
                className="input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                required
              />
            </label>
            {!editing.is_system ? (
              <>
                <div className="field">
                  <span className="field-label">{t("parentCategory")}</span>
                  <Combobox
                    value={editing.parent_id || ""}
                    options={parentOptions.filter((o) => o.value !== editing.id)}
                    onChange={(v) => setEditing({ ...editing, parent_id: v || null })}
                  />
                </div>
                <div className="field">
                  <span className="field-label">{t("visibility")}</span>
                  <Segmented
                    value={editing.visibility}
                    options={visSegOptions}
                    onChange={(v) => setEditing({ ...editing, visibility: v })}
                  />
                </div>
              </>
            ) : (
              <span className="muted">{t("systemRenameOnly")}</span>
            )}
          </form>
        ) : null}
      </Modal>

      {confirmElement}
      <Toast message={toast} />
    </div>
  );
}

function DeleteModePicker({ onPick }: { onPick: (mode: string) => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState("move_to_inbox");
  const opts = [
    { value: "move_to_inbox", label: t("deleteModeInbox") },
    { value: "move_to_parent", label: t("deleteModeParent") },
    { value: "cascade_soft_delete", label: t("deleteModeCascade") },
  ];
  return (
    <div className="stack" style={{ gap: 6, marginTop: 12 }}>
      <span className="field-label">{t("deleteMode")}</span>
      {opts.map((o) => (
        <label key={o.value} className="row" style={{ gap: 8, fontSize: 13, cursor: "pointer" }}>
          <input
            type="radio"
            name="folder-delete-mode"
            checked={mode === o.value}
            onChange={() => {
              setMode(o.value);
              onPick(o.value);
            }}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}
