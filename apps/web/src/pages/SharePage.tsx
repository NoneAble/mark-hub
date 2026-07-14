import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../i18n";
import { BookmarkCard } from "../components/BookmarkCard";
import { LogoMark, PageHeader } from "../components/ui";

export function SharePage() {
  const { token } = useParams();
  const { api } = useAuth();
  const { t } = useI18n();
  const [data, setData] = useState<any>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);

  async function load() {
    setError("");
    try {
      const r = await api.get(`/shares/${token}`);
      setData(r);
      setNeedsPassword(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed";
      setError(msg);
      if (msg.toLowerCase().includes("password")) setNeedsPassword(true);
    }
  }

  async function unlock() {
    setError("");
    try {
      const r = await api.post(`/shares/${token}/unlock`, { password });
      setData(r);
      setNeedsPassword(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setNeedsPassword(true);
    }
  }

  useEffect(() => {
    void load();
  }, [token]);

  return (
    <div style={{ minHeight: "100vh" }}>
      <header className="public-topbar">
        <div className="row" style={{ gap: 9 }}>
          <LogoMark size={28} />
          <strong style={{ fontSize: 16 }}>{t("appName")}</strong>
          <span className="badge">{t("shares")}</span>
        </div>
        <Link to="/" className="btn btn-sm spacer">
          {t("publicNav")}
        </Link>
      </header>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "28px 20px 60px" }}>
        <PageHeader title={data?.folder?.name || data?.bookmark?.title || t("shares")} />
        {needsPassword ? (
          <div className="card stack" style={{ maxWidth: 360 }}>
            <label className="field">
              {t("password")}
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button className="btn btn-primary" type="button" onClick={() => void unlock()}>
              {t("unlock")}
            </button>
          </div>
        ) : null}
        {error ? <div className="error" style={{ marginBottom: 12 }}>{error}</div> : null}
        {data?.bookmark ? (
          <div className="grid-cards">
            <BookmarkCard
              bm={data.bookmark}
              linkTitleOnly={false}
            />
          </div>
        ) : null}
        {data?.bookmarks ? (
          <div className="grid-cards">
            {data.bookmarks.map((b: any) => (
              <BookmarkCard key={b.id || b.url} bm={b} linkTitleOnly={false} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
