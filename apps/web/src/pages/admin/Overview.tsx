import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";

export function AdminOverview() {
  const { api } = useAuth();
  const { t } = useI18n();
  const [profile, setProfile] = useState<any>(null);

  useEffect(() => {
    void api.get("/analytics/profile").then(setProfile).catch(() => setProfile(null));
  }, [api]);

  return (
    <div>
      <h1 className="page-title">{t("overview")}</h1>
      <div className="grid-cards">
        <div className="card">
          <div className="muted">Bookmarks</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{profile?.total_bookmarks ?? "—"}</div>
        </div>
        <div className="card">
          <div className="muted">Folders</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{profile?.total_folders ?? "—"}</div>
        </div>
        <div className="card">
          <div className="muted">Last 30 days</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{profile?.added_last_30_days ?? "—"}</div>
        </div>
        <div className="card">
          <div className="muted">Favorites</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{profile?.favorites ?? "—"}</div>
        </div>
      </div>
      {profile?.top_domains?.length ? (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Top domains</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {profile.top_domains.map((d: any) => (
                <tr key={d.domain}>
                  <td>{d.domain}</td>
                  <td>{d.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
