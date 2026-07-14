import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";
import { LogoMark, PageHeader } from "../../components/ui";

export function AdminAbout() {
  const { api } = useAuth();
  const { t, lang } = useI18n();
  const [ver, setVer] = useState<any>(null);
  const [latest, setLatest] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);

  useEffect(() => {
    void api.get("/version").then(setVer);
    void api.get("/version/latest").then(setLatest).catch(() => null);
    void api.get("/health").then(setHealth).catch(() => setHealth(null));
  }, [api]);

  const rows = [
    {
      name: "API",
      val: health?.status || "ok",
      ok: (health?.status || "ok") === "ok",
    },
    {
      name: "Database",
      val: health?.database || health?.db || "sqlite",
      ok: true,
    },
    {
      name: "Runtime",
      val: ver?.runtime || "Docker / Python",
      ok: true,
    },
    {
      name: lang === "zh" ? "最新版本" : "Latest",
      val: latest?.latest
        ? `${latest.latest}${latest.update_available ? " ↑" : ""}`
        : ver?.version || "—",
      ok: !latest?.update_available,
    },
  ];

  return (
    <div style={{ maxWidth: 560 }}>
      <PageHeader title={t("about")} />
      <div className="card stack" style={{ padding: 24, gap: 14 }}>
        <div className="row" style={{ gap: 12 }}>
          <LogoMark size={44} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{ver?.name || "MarkHub"}</div>
            <div className="mono">
              v{ver?.version || "0.1.0"} · Docker Runtime · SQLite
            </div>
          </div>
          <button
            type="button"
            className="btn btn-soft btn-sm spacer"
            onClick={() => void api.get("/version/latest").then(setLatest)}
          >
            {t("checkUpdate")}
          </button>
        </div>
        <div className="stack" style={{ gap: 8, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          {rows.map((h) => (
            <div key={h.name} className="row" style={{ gap: 10, fontSize: 12.5 }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: h.ok ? "var(--ok)" : "var(--warn)",
                }}
              />
              <span style={{ color: "var(--text2)" }}>{h.name}</span>
              <span className="mono spacer">{h.val}</span>
            </div>
          ))}
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
          {lang === "zh"
            ? "自托管书签导航与工作台。支持 Docker 与 Cloudflare Workers 部署。纯 Web，无需浏览器扩展。"
            : "Self-hosted bookmark hub. Docker + Cloudflare Workers. Web-only — no browser extension."}
        </p>
      </div>
    </div>
  );
}
