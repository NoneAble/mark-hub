import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";
import { applyThemeMode } from "../../lib/theme";
import { Chip, PageHeader } from "../../components/ui";

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
    applyThemeMode(s.theme);
    if (s.theme === "dark" || s.theme === "light") {
      localStorage.setItem("markhub_theme", s.theme);
    }
    if (s.card_density) document.documentElement.dataset.density = s.card_density;
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
    <div style={{ maxWidth: 560 }}>
      <PageHeader title={t("settings")} />
      <div className="stack" style={{ gap: 14 }}>
        <div className="card" style={{ padding: 18 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 12 }}>{t("density")}</div>
          <div className="row" style={{ gap: 8 }}>
            {(["compact", "comfortable", "spacious"] as const).map((d) => (
              <Chip
                key={d}
                active={(s.card_density || "comfortable") === d}
                onClick={() => setS({ ...s, card_density: d })}
              >
                {t(d)}
              </Chip>
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: 18 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 12 }}>{t("theme")}</div>
          <div className="row" style={{ gap: 8 }}>
            {(["system", "light", "dark"] as const).map((th) => (
              <Chip
                key={th}
                active={(s.theme || "system") === th}
                onClick={() => setS({ ...s, theme: th })}
              >
                {th === "light" ? t("light") : th === "dark" ? t("dark") : "System"}
              </Chip>
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: 18 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 12 }}>{t("language")}</div>
          <div className="row" style={{ gap: 8 }}>
            <Chip active={(s.language || lang) === "zh"} onClick={() => setS({ ...s, language: "zh" })}>
              中文
            </Chip>
            <Chip active={(s.language || lang) === "en"} onClick={() => setS({ ...s, language: "en" })}>
              English
            </Chip>
          </div>
        </div>

        <div className="card stack" style={{ padding: 18 }}>
          <label className="field">
            Collection / board title
            <input
              className="input"
              value={s.collection_board_name || ""}
              onChange={(e) => setS({ ...s, collection_board_name: e.target.value })}
              data-testid="collection-board-name"
              placeholder="Workbench title override"
            />
          </label>
          <label className="field">
            {t("wallpaper")}
            <input
              className="input input-mono"
              value={s.wallpaper || ""}
              onChange={(e) => setS({ ...s, wallpaper: e.target.value })}
            />
          </label>
          <label className="field">
            Root folder
            <select
              className="input"
              value={s.root_folder_id || ""}
              onChange={(e) => setS({ ...s, root_folder_id: e.target.value || null })}
              data-testid="root-folder"
            >
              <option value="">—</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <div>
            <div className="section-label" style={{ marginBottom: 8 }}>
              Pinned folders
            </div>
            <div className="row wrap">
              {folders.map((f) => (
                <Chip
                  key={f.id}
                  active={pinned.includes(f.id)}
                  onClick={() => toggleList("pinned_folder_ids", f.id)}
                >
                  {f.name}
                </Chip>
              ))}
            </div>
          </div>
          <div>
            <div className="section-label" style={{ marginBottom: 8 }}>
              Expanded folders
            </div>
            <div className="row wrap">
              {folders.map((f) => (
                <Chip
                  key={f.id}
                  active={expanded.includes(f.id)}
                  onClick={() => toggleList("expanded_folder_ids", f.id)}
                >
                  {f.name}
                </Chip>
              ))}
            </div>
          </div>
          <button className="btn btn-primary" type="button" onClick={() => void save()} style={{ alignSelf: "flex-start" }}>
            {t("save")}
          </button>
          {msg ? <div className="success">{msg}</div> : null}
        </div>
      </div>
    </div>
  );
}
