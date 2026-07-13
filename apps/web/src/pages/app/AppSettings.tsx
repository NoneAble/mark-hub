import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim()) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p.map(String);
    } catch {
      return v.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

export function AppSettingsPage() {
  const { api } = useAuth();
  const { t, lang, setLang } = useI18n();
  const [s, setS] = useState<any>({});
  const [folders, setFolders] = useState<any[]>([]);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    void api.get("/settings").then(setS);
    void api.get<{ items: any[] }>("/folders").then((r) => setFolders(r.items || []));
  }, [api]);

  async function save() {
    const r = await api.put("/settings", {
      card_density: s.card_density,
      wallpaper: s.wallpaper,
      theme: s.theme,
      language: s.language,
      root_folder_id: s.root_folder_id || null,
      pinned_folder_ids: asArray(s.pinned_folder_ids),
      expanded_folder_ids: asArray(s.expanded_folder_ids),
      collection_board_name: s.collection_board_name || "",
    });
    setS(r);
    if (s.language === "zh" || s.language === "en") setLang(s.language);
    const dark =
      s.theme === "dark" ||
      (s.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", !!dark);
    setMsg("Saved");
  }

  const pinned = asArray(s.pinned_folder_ids);
  const expanded = asArray(s.expanded_folder_ids);

  function toggleList(key: "pinned_folder_ids" | "expanded_folder_ids", id: string) {
    const cur = asArray(s[key]);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    setS({ ...s, [key]: next });
  }

  return (
    <div className="stack" style={{ maxWidth: 520 }}>
      <h1 className="page-title">{t("settings")}</h1>
      <div className="card stack">
        <label>
          Density
          <select
            className="input"
            value={s.card_density || "comfortable"}
            onChange={(e) => setS({ ...s, card_density: e.target.value })}
          >
            <option value="compact">compact</option>
            <option value="comfortable">comfortable</option>
            <option value="spacious">spacious</option>
          </select>
        </label>
        <label>
          Wallpaper URL
          <input
            className="input"
            value={s.wallpaper || ""}
            onChange={(e) => setS({ ...s, wallpaper: e.target.value })}
          />
        </label>
        <label>
          Theme
          <select
            className="input"
            value={s.theme || "system"}
            onChange={(e) => setS({ ...s, theme: e.target.value })}
          >
            <option value="system">system</option>
            <option value="light">light</option>
            <option value="dark">dark</option>
          </select>
        </label>
        <label>
          Language ({lang})
          <select
            className="input"
            value={s.language || "auto"}
            onChange={(e) => setS({ ...s, language: e.target.value })}
          >
            <option value="auto">auto</option>
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <label>
          Collection / board title
          <input
            className="input"
            value={s.collection_board_name || ""}
            onChange={(e) => setS({ ...s, collection_board_name: e.target.value })}
            data-testid="collection-board-name"
            placeholder="Workbench title override"
          />
        </label>
        <label>
          Root folder
          <select
            className="input"
            value={s.root_folder_id || ""}
            onChange={(e) => setS({ ...s, root_folder_id: e.target.value || null })}
            data-testid="root-folder"
          >
            <option value="">(all folders)</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {f.is_system ? " ⚙" : ""}
              </option>
            ))}
          </select>
        </label>
        <fieldset style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
          <legend>Pinned folders</legend>
          <div className="stack" style={{ maxHeight: 160, overflow: "auto" }}>
            {folders.map((f) => (
              <label key={f.id} className="row">
                <input
                  type="checkbox"
                  checked={pinned.includes(f.id)}
                  onChange={() => toggleList("pinned_folder_ids", f.id)}
                />
                {f.name}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
          <legend>Expanded folders (default tree state)</legend>
          <div className="stack" style={{ maxHeight: 160, overflow: "auto" }}>
            {folders.map((f) => (
              <label key={f.id} className="row">
                <input
                  type="checkbox"
                  checked={expanded.includes(f.id)}
                  onChange={() => toggleList("expanded_folder_ids", f.id)}
                />
                {f.name}
              </label>
            ))}
          </div>
        </fieldset>
        <button className="btn btn-primary" type="button" onClick={() => void save()} data-testid="save-settings">
          {t("save")}
        </button>
        {msg ? <div className="success">{msg}</div> : null}
      </div>
    </div>
  );
}
