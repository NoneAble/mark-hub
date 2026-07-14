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
    <div className="public-page">
      <header className="public-topbar">
        <div className="public-brand">
          <LogoMark size={28} />
          <strong style={{ fontSize: 16 }}>{t("appName")}</strong>
          <span className="badge">{t("shares")}</span>
        </div>
        <div className="public-actions">
          <Link to="/" className="btn topbar-btn">
            {t("publicNav")}
          </Link>
        </div>
      </header>
      <div className="public-content" style={{ maxWidth: 900, margin: "0 auto", width: "100%" }}>
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
