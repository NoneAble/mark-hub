import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";
import { applyAccentHue, applyThemeMode } from "../../lib/theme";
import { Chip, PageHeader } from "../../components/ui";

const PRESETS: Record<string, { hue: number; label: string }> = {
  blue: { hue: 260, label: "Blue" },
  green: { hue: 160, label: "Green" },
  orange: { hue: 55, label: "Orange" },
  purple: { hue: 300, label: "Purple" },
};

function applyTheme(s: any) {
  applyThemeMode(s.theme || "system");
  const preset = s.theme_preset || "blue";
  if (PRESETS[preset]) applyAccentHue(PRESETS[preset].hue);
  else if (s.accent && String(s.accent).startsWith("oklch")) {
    document.documentElement.style.setProperty("--accent", s.accent);
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
  if (s.theme === "dark" || s.theme === "light") {
    localStorage.setItem("markhub_theme", s.theme);
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
    <div style={{ maxWidth: 640 }}>
      <PageHeader title={t("settings")} />
      <div className="stack" style={{ gap: 14 }}>
        <div className="card" style={{ padding: 18 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 12 }}>{t("theme")}</div>
          <div className="row" style={{ gap: 8 }}>
            {(["light", "dark", "system"] as const).map((th) => (
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
          <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 12 }}>{t("accent")}</div>
          <div className="row" style={{ gap: 8 }}>
            {Object.entries(PRESETS).map(([k, v]) => (
              <Chip
                key={k}
                active={(s.theme_preset || "blue") === k}
                onClick={() => setS({ ...s, theme_preset: k })}
              >
                {v.label}
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

        <div className="card stack" style={{ padding: 18 }}>
          <label className="field">
            {t("title")}
            <input
              className="input"
              value={s.site_title || ""}
              onChange={(e) => setS({ ...s, site_title: e.target.value })}
            />
          </label>
          <label className="field">
            {t("wallpaper")}
            <input
              className="input input-mono"
              value={s.wallpaper || ""}
              onChange={(e) => setS({ ...s, wallpaper: e.target.value })}
              placeholder="https://..."
            />
          </label>
          <button className="btn btn-primary" type="button" onClick={() => void save()} style={{ alignSelf: "flex-start" }}>
            {t("save")}
          </button>
          {msg ? <div className="success">{msg}</div> : null}
        </div>
      </div>
    </div>
  );
}
