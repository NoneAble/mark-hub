import { FormEvent, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";
import { EmptyState, Modal, PageHeader, Toast, useToast } from "../../components/ui";
import { ColorDot, ColorPicker, useConfirm } from "../../components/form";

type Tag = { id: string; name: string; color?: string | null };
type Bm = { tags?: Array<string | { name: string }> };

export function AdminTags() {
  const { api } = useAuth();
  const { t } = useI18n();
  const { toast, showToast } = useToast();
  const { confirm, confirmElement } = useConfirm();
  const [items, setItems] = useState<Tag[]>([]);
  const [usage, setUsage] = useState<Map<string, number>>(new Map());
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const [tg, bm] = await Promise.all([
      api.get<{ items: Tag[] }>("/tags"),
      api.get<{ items: Bm[] }>("/bookmarks?limit=1000"),
    ]);
    setItems(tg.items);
    const m = new Map<string, number>();
    for (const b of bm.items) {
      for (const x of b.tags || []) {
        const n = typeof x === "string" ? x : x.name;
        m.set(n, (m.get(n) || 0) + 1);
      }
    }
    setUsage(m);
  }

  useEffect(() => {
    void load().catch((e) => setError(String(e.message || e)));
  }, []);

  const sorted = useMemo(
    () => [...items].sort((a, b) => (usage.get(b.name) || 0) - (usage.get(a.name) || 0) || a.name.localeCompare(b.name)),
    [items, usage],
  );

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api.post("/tags", { name, color: color || undefined });
      setName("");
      setColor(null);
      showToast(t("newTag") + " ✓");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setError("");
    await api.patch(`/tags/${editing.id}`, { name: editing.name, color: editing.color || null });
    setEditing(null);
    showToast(t("save") + " ✓");
    await load();
  }

  async function onDelete(tag: Tag) {
    const ok = await confirm({ message: t("confirmDeleteTag"), danger: true });
    if (!ok) return;
    setError("");
    await api.delete(`/tags/${tag.id}`);
    showToast(t("delete") + " ✓");
    await load();
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <PageHeader title={t("tagManage")} />
      {error ? <div className="error" style={{ marginBottom: 10 }}>{error}</div> : null}

      <form className="card row wrap" onSubmit={(e) => void onCreate(e)} style={{ marginBottom: 16, gap: 10 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 160 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("newTag")}
          required
        />
        <ColorPicker value={color} onChange={setColor} title={t("color")} />
        <button className="btn btn-primary" type="submit">
          {t("add")}
        </button>
      </form>

      {sorted.length ? (
        <div className="card card-flush">
          {sorted.map((tag) => (
            <div key={tag.id} className="manage-row">
              <span
                className="tagpick-chip"
                style={
                  tag.color
                    ? {
                        background: `color-mix(in srgb, ${tag.color} 14%, transparent)`,
                        color: `color-mix(in srgb, ${tag.color} 80%, var(--text))`,
                      }
                    : undefined
                }
              >
                <ColorDot color={tag.color} size={8} />
                {tag.name}
              </span>
              <span className="muted-sm">
                {usage.get(tag.name) || 0} {t("itemsUnit")}
              </span>
              <div className="manage-actions">
                <button className="btn-icon" type="button" title={t("edit")} onClick={() => setEditing({ ...tag })}>
                  ✎
                </button>
                <button className="btn-icon" type="button" title={t("delete")} onClick={() => void onDelete(tag)}>
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState>{t("empty")}</EmptyState>
      )}

      <Modal
        open={!!editing}
        title={t("edit")}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              {t("cancel")}
            </button>
            <button type="submit" form="tag-edit" className="btn btn-primary">
              {t("save")}
            </button>
          </>
        }
      >
        {editing ? (
          <form id="tag-edit" className="stack" onSubmit={(e) => void onSaveEdit(e)}>
            <label className="field">
              {t("title")}
              <input
                className="input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                required
              />
            </label>
            <div className="field">
              <span className="field-label">{t("color")}</span>
              <div className="row" style={{ gap: 10 }}>
                <ColorPicker
                  value={editing.color || null}
                  onChange={(c) => setEditing({ ...editing, color: c })}
                />
                <span
                  className="tagpick-chip"
                  style={
                    editing.color
                      ? {
                          background: `color-mix(in srgb, ${editing.color} 14%, transparent)`,
                          color: `color-mix(in srgb, ${editing.color} 80%, var(--text))`,
                        }
                      : undefined
                  }
                >
                  <ColorDot color={editing.color} size={8} />
                  {editing.name || t("tags")}
                </span>
              </div>
            </div>
          </form>
        ) : null}
      </Modal>

      {confirmElement}
      <Toast message={toast} />
    </div>
  );
}
