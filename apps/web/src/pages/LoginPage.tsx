import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../i18n";

export function LoginPage() {
  const { login } = useAuth();
  const { t } = useI18n();
  const nav = useNavigate();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const u = await login(username, password);
      nav(u.must_change_password ? "/admin/account?force=1" : "/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 22,
      }}
    >
      <div className="row" style={{ gap: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: "var(--accent)",
          }}
        />
        <strong style={{ fontSize: 22 }}>{t("appName")}</strong>
      </div>
      <form className="card stack login-card" onSubmit={onSubmit}>
        <h2 style={{ margin: 0 }}>{t("login")}</h2>
        <label className="stack" style={{ gap: 4 }}>
          <span className="muted">{t("username")}</span>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="muted">{t("password")}</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error ? <div className="error">{error}</div> : null}
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? "…" : t("login")}
        </button>
        <Link to="/" className="muted">
          ← {t("publicNav")}
        </Link>
      </form>
    </div>
  );
}
