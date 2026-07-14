import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../i18n";
import { LogoMark } from "../components/ui";

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
    <div className="login-page">
      <div className="row" style={{ gap: 10 }}>
        <LogoMark size={36} />
        <strong style={{ fontSize: 22 }}>{t("appName")}</strong>
      </div>
      <form className="login-card" onSubmit={onSubmit}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>{t("adminLogin")}</div>
        <label className="field">
          {t("username")}
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label className="field">
          {t("password")}
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="admin123"
            autoComplete="current-password"
          />
        </label>
        {error ? <div className="error">{error}</div> : null}
        <button className="btn btn-primary" type="submit" disabled={loading} style={{ padding: 11 }}>
          {loading ? "…" : t("login")}
        </button>
        <div style={{ fontSize: 11.5, color: "var(--text3)", textAlign: "center" }}>{t("loginHint")}</div>
      </form>
      <Link to="/" style={{ fontSize: 13 }}>
        ← {t("backToNav")}
      </Link>
    </div>
  );
}
