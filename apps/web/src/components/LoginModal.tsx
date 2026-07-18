import { FormEvent, useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { useI18n } from "../i18n";
import { Modal } from "./ui";

/** Login as a modal on the public page (no dedicated route). */
export function LoginModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { login } = useAuth();
  const { t } = useI18n();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword("");
      setError("");
    }
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(username, password);
      // must_change_password is handled by the page (forced settings modal).
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t("login")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            type="submit"
            form="login-form"
            className="btn btn-primary"
            disabled={loading}
            data-testid="login-submit"
          >
            {loading ? "…" : t("login")}
          </button>
        </>
      }
    >
      <form id="login-form" className="stack" onSubmit={(e) => void onSubmit(e)}>
        <label className="field">
          {t("username")}
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            data-testid="login-username"
          />
        </label>
        <label className="field">
          {t("password")}
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            data-testid="login-password"
          />
        </label>
        {error ? <div className="error">{error}</div> : null}
        <div className="muted-sm" style={{ textAlign: "center" }}>
          {t("loginHint")}
        </div>
      </form>
    </Modal>
  );
}
