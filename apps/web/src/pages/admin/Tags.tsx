import { FormEvent, useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";

export function AdminTags() {
  const { api } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<any | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setItems((await api.get<{ items: any[] }>("/tags")).items);
  }
  useEffect(() => {
    void load().catch((e) => setError(String(e.message || e)));
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError("");
    await api.post("/tags", { name });
    setName("");
    await load();
  }

  async function onRename(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setError("");
    await api.patch(`/tags/${editing.id}`, { name: editing.name, color: editing.color });
    setEditing(null);
    await load();
  }

  async function onDelete(id: string) {
    setError("");
    await api.delete(`/tags/${id}`);
    await load();
  }

  return (
    <div>
      <h1 className="page-title">{t("tags")}</h1>
      {error ? <div className="error">{error}</div> : null}
      <form className="card row" onSubmit={onCreate} style={{ marginBottom: 16 }}>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("title")}
          required
        />
        <button className="btn btn-primary" type="submit">
          {t("add")}
        </button>
      </form>

      {editing ? (
        <form className="card row wrap" onSubmit={onRename} style={{ marginBottom: 16, gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1 }}
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            required
          />
          <input
            className="input"
            style={{ width: 120 }}
            value={editing.color || ""}
            onChange={(e) => setEditing({ ...editing, color: e.target.value })}
            placeholder="color"
          />
          <button className="btn btn-primary" type="submit">
            {t("save")}
          </button>
          <button className="btn" type="button" onClick={() => setEditing(null)}>
            {t("cancel")}
          </button>
        </form>
      ) : null}

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>{t("title")}</th>
              <th>Color</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((tag) => (
              <tr key={tag.id}>
                <td>
                  <span className="badge" style={{ fontSize: 13, padding: "6px 12px" }}>
                    {tag.name}
                  </span>
                </td>
                <td className="muted">{tag.color || "—"}</td>
                <td className="row" style={{ gap: 4 }}>
                  <button className="btn" type="button" onClick={() => setEditing({ ...tag })}>
                    {t("edit")}
                  </button>
                  <button className="btn" type="button" onClick={() => void onDelete(tag.id)}>
                    {t("delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
