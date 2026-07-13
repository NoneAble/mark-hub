import { FormEvent, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../lib/auth";

export function AdminAccount() {
  const { api, user, setUser } = useAuth();
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
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div>
      <h1 className="page-title">Account</h1>
      {force ? (
        <div className="card" style={{ marginBottom: 12, borderColor: "var(--warn)" }}>
          You must change the default password before continuing.
        </div>
      ) : null}
      <form className="card stack" onSubmit={onSubmit} style={{ maxWidth: 420 }}>
        <label>
          Current password
          <input className="input" type="password" value={current_password} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label>
          Username
          <input className="input" value={new_username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          New password
          <input className="input" type="password" value={new_password} onChange={(e) => setPassword(e.target.value)} required={!!force} />
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
