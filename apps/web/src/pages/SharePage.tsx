import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../i18n";

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
      // F-018: body-based unlock, never put password in query string
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
    <div style={{ maxWidth: 720, margin: "40px auto", padding: 20 }}>
      <h1>{t("shares")}</h1>
      {needsPassword ? (
        <div className="card stack">
          <input
            className="input"
            type="password"
            placeholder={t("password")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="btn btn-primary" type="button" onClick={() => void unlock()}>
            Unlock
          </button>
        </div>
      ) : null}
      {error && !needsPassword ? <div className="error">{error}</div> : null}
      {error && needsPassword ? <div className="error">{error}</div> : null}
      {data?.bookmark ? (
        <div className="card">
          <h2>{data.bookmark.title}</h2>
          <a href={data.bookmark.url}>{data.bookmark.url}</a>
          <p className="muted">{data.bookmark.description}</p>
        </div>
      ) : null}
      {data?.bookmarks ? (
        <div className="stack">
          <h2>{data.folder?.name}</h2>
          {data.bookmarks.map((b: any, i: number) => (
            <a key={i} className="card" href={b.url} target="_blank" rel="noreferrer">
              {b.title}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
