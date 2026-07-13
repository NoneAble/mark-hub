import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";

export function AdminAbout() {
  const { api } = useAuth();
  const [ver, setVer] = useState<any>(null);
  const [latest, setLatest] = useState<any>(null);

  useEffect(() => {
    void api.get("/version").then(setVer);
    void api.get("/version/latest").then(setLatest);
  }, [api]);

  return (
    <div>
      <h1 className="page-title">About</h1>
      <div className="card stack">
        <div>
          <strong>{ver?.name || "MarkHub"}</strong>
        </div>
        <div className="muted">Version: {ver?.version}</div>
        <div className="muted">
          Latest: {latest?.latest} {latest?.update_available ? "(update available)" : "(up to date)"}
        </div>
        <p className="muted">
          Self-hosted bookmark hub. Docker + Cloudflare Workers. Web-only — no browser extension.
        </p>
      </div>
    </div>
  );
}
