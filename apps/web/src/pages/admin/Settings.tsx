import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";

const PRESETS: Record<string, { accent: string; label: string }> = {
  default: { accent: "oklch(0.55 0.18 260)", label: "Default" },
  linear: { accent: "oklch(0.6 0.18 250)", label: "Linear" },
  emerald: { accent: "oklch(0.58 0.14 160)", label: "Emerald" },
  rose: { accent: "oklch(0.58 0.16 20)", label: "Rose" },
  amber: { accent: "oklch(0.7 0.14 80)", label: "Amber" },
};

function applyTheme(s: any) {
  const theme = s.theme || "system";
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  const accent = s.accent || PRESETS[s.theme_preset || "default"]?.accent;
  if (accent) {
    document.documentElement.style.setProperty("--accent", accent);
    document.documentElement.style.setProperty("--accent-text", accent);
  }
  if (s.wallpaper) {
    document.body.style.backgroundImage = `url(${s.wallpaper})`;
    document.body.style.backgroundSize = "cover";
    document.body.style.backgroundAttachment = "fixed";
  } else {
    document.body.style.backgroundImage = "";
  }
  if (s.card_density) {
    document.documentElement.dataset.density = s.card_density;
  }
}

export function AdminSettings() {
  const { api } = useAuth();
  const { lang, setLang, t } = useI18n();
  const [s, setS] = useState<any>({});
  const [msg, setMsg] = useState("");

  useEffect(() => {
    void api.get<Record<string, any>>("/settings").then((r) => {
      setS(r);
      applyTheme(r);
      if (r.language === "zh" || r.language === "en") setLang(r.language);
    });
  }, [api, setLang]);

  useEffect(() => {
    applyTheme(s);
  }, [s.theme, s.accent, s.theme_preset, s.wallpaper, s.card_density]);

  async function save() {
    const r = await api.put("/settings", {
      theme: s.theme,
      language: s.language,
      site_title: s.site_title,
      accent: s.accent,
      theme_preset: s.theme_preset,
      wallpaper: s.wallpaper,
      card_density: s.card_density,
    });
    setS(r);
    applyTheme(r);
    if (s.language === "zh" || s.language === "en") setLang(s.language);
    setMsg(t("save"));
  }

  return (
    <div className="stack">
      <h1 className="page-title">{t("settings")}</h1>
      <div className="card stack">
        <label>
          {t("title")}
          <input
            className="input"
            value={s.site_title || ""}
            onChange={(e) => setS({ ...s, site_title: e.target.value })}
          />
        </label>
        <label>
          {t("theme")}
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
          {t("themePreset")}
          <select
            className="input"
            value={s.theme_preset || "default"}
            onChange={(e) => {
              const preset = e.target.value;
              setS({
                ...s,
                theme_preset: preset,
                accent: PRESETS[preset]?.accent || s.accent,
              });
            }}
          >
            {Object.entries(PRESETS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("accent")}
          <input
            className="input"
            value={s.accent || ""}
            onChange={(e) => setS({ ...s, accent: e.target.value })}
            placeholder="oklch(...) or #hex"
          />
        </label>
        <label>
          {t("wallpaper")}
          <input
            className="input"
            value={s.wallpaper || ""}
            onChange={(e) => setS({ ...s, wallpaper: e.target.value })}
            placeholder="https://..."
          />
        </label>
        <label>
          {t("language")}
          <select
            className="input"
            value={s.language || lang}
            onChange={(e) => setS({ ...s, language: e.target.value })}
          >
            <option value="auto">auto</option>
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <label>
          {t("settings")} · density
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
        <button className="btn btn-primary" type="button" onClick={() => void save()}>
          {t("save")}
        </button>
        {msg ? <div className="success">{msg}</div> : null}
      </div>
    </div>
  );
}
