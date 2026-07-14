import { FormEvent, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";
import { PageHeader } from "../../components/ui";

export function AdminAccount() {
  const { api, user, setUser } = useAuth();
  const { t } = useI18n();
  const [params] = useSearchParams();
  const force = params.get("force") === "1" || user?.must_change_password;
  const [current_password, setCurrent] = useState("");
  const [new_username, setUsername] = useState(user?.username || "");
  const [new_password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const r = await api.put<{ id: string; username: string; must_change_password: boolean }>(
        "/auth/credentials",
        { current_password, new_username, new_password: new_password || undefined },
      );
      setUser(r);
      setMsg("Updated");
      setCurrent("");
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("failed"));
    }
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <PageHeader title={t("account")} />
      {force ? (
        <div
          className="card"
          style={{ marginBottom: 14, borderColor: "var(--warn)", background: "rgba(217,119,6,.06)" }}
        >
          You must change the default password before continuing. {t("mustChangePassword")}
        </div>
      ) : null}
      <form className="card stack" onSubmit={onSubmit}>
        <label className="field">
          Current password
          <input
            className="input"
            type="password"
            value={current_password}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </label>
        <label className="field">
          Username
          <input
            className="input"
            value={new_username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          New password
          <input
            className="input"
            type="password"
            value={new_password}
            onChange={(e) => setPassword(e.target.value)}
            required={!!force}
          />
        </label>
        {error ? <div className="error">{error}</div> : null}
        {msg ? <div className="success">{msg}</div> : null}
        <button className="btn btn-primary" type="submit">
          Update credentials
        </button>
      </form>
    </div>
  );
}
