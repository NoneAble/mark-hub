import { FormEvent, useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { useI18n } from "../i18n";
import { Modal, Toast, useToast } from "./ui";
import { Switch, useConfirm } from "./form";

type ImportStrategy = "skip_duplicate" | "merge" | "replace_all";
export type SettingsTab = "account" | "backup" | "webdav" | "s3";

function detectFormat(name: string, text: string): "json" | "csv" | "html" {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".json")) return "json";
  const trimmed = text.trim();
  if (trimmed.startsWith("<!") || /<DL|<H1|<A\s+HREF/i.test(trimmed)) return "html";
  if (trimmed.includes(",") && /title.*url|url.*title/i.test(trimmed.split("\n")[0] || "")) {
    return "csv";
  }
  return "json";
}

export function SettingsModal({
  open,
  initialTab = "account",
  /** must_change_password flow: lock to the account tab and disable closing. */
  forceAccount = false,
  onClose,
}: {
  open: boolean;
  initialTab?: SettingsTab;
  forceAccount?: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  useEffect(() => {
    if (open) setTab(forceAccount ? "account" : initialTab);
  }, [open, initialTab, forceAccount]);

  const tabs: [SettingsTab, string][] = forceAccount
    ? [["account", t("accountTab")]]
    : [
        ["account", t("accountTab")],
        ["backup", t("backupTab")],
        ["webdav", t("webdavTab")],
        ["s3", t("s3Tab")],
      ];

  return (
    <Modal
      open={open}
      wide
      title={t("settings")}
      onClose={forceAccount ? () => {} : onClose}
    >
      <div className="tabs">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`tab${tab === id ? " active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "account" ? <AccountSection force={forceAccount} /> : null}
      {tab === "backup" ? <BackupSection /> : null}
      {tab === "webdav" ? <WebdavSection /> : null}
      {tab === "s3" ? <S3Section /> : null}
    </Modal>
  );
}

/* ---------- account ---------- */

function AccountSection({ force }: { force: boolean }) {
  const { api, user, setUser, logout } = useAuth();
  const { t } = useI18n();
  const [current_password, setCurrent] = useState("");
  const [new_username, setUsername] = useState(user?.username || "");
  const [new_password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (user?.username) setUsername(user.username);
  }, [user?.username]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const r = await api.put<{ id: string; username: string; must_change_password: boolean }>(
        "/auth/credentials",
        { current_password, new_username, new_password: new_password || undefined },
      );
      setUser(r);
      setMsg(t("updated"));
      setCurrent("");
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("failed"));
    }
  }

  return (
    <div>
      {force ? (
        <div
          className="card"
          style={{ marginBottom: 14, borderColor: "var(--warn)", background: "rgba(217,119,6,.06)" }}
        >
          {t("mustChangePassword")}
        </div>
      ) : null}
      <form className="stack" onSubmit={(e) => void onSubmit(e)}>
        <label className="field">
          {t("currentPassword")}
          <input
            className="input"
            type="password"
            value={current_password}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <label className="field">
          {t("username")}
          <input
            className="input"
            value={new_username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          {t("newPassword")}
          <input
            className="input"
            type="password"
            value={new_password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required={force}
          />
        </label>
        {error ? <div className="error">{error}</div> : null}
        {msg ? <div className="success">{msg}</div> : null}
        <div className="row">
          <button className="btn btn-primary" type="submit">
            {t("updateCredentials")}
          </button>
          {force ? (
            // Forced-change mode blocks closing — leave an exit for users who
            // can't produce the current password.
            <button className="btn" type="button" onClick={logout}>
              {t("logout")}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

/* ---------- file backup / import ---------- */

function BackupSection() {
  const { api } = useAuth();
  const { t } = useI18n();
  const { toast, showToast } = useToast();
  const { confirm, confirmElement } = useConfirm();
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [importText, setImportText] = useState("");
  const [importFormat, setImportFormat] = useState<"json" | "csv" | "html">("json");
  const [strategy, setStrategy] = useState<ImportStrategy>("skip_duplicate");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);

  async function exportFmt(format: string) {
    if (format === "json") {
      const data = await api.get("/backup/export?format=json");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      download(blob, "markhub.json");
    } else {
      const res = await fetch(`/api/v1/backup/export?format=${format}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("markhub_token")}` },
      });
      const blob = await res.blob();
      download(blob, `markhub.${format}`);
    }
    showToast(`${t("export")} ✓`);
  }

  function download(blob: Blob, name: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function onFile(file: File | null) {
    if (!file) return;
    const text = await file.text();
    setImportText(text);
    setFileName(file.name);
    setImportFormat(detectFormat(file.name, text));
    setMsg(`Loaded ${file.name} (${text.length} bytes)`);
    setErr("");
  }

  async function doImport() {
    setErr("");
    setMsg("");
    if (!importText.trim()) {
      setErr("Paste content or choose a file first");
      return;
    }
    if (strategy === "replace_all") {
      const ok = await confirm({
        message:
          "Replace ALL existing bookmarks with this import? Soft-deleted rows can be recovered for 30 days.",
        danger: true,
        confirmLabel: t("import"),
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await api.post<{
        created: number;
        skipped: number;
        merged?: number;
        ok?: boolean;
      }>("/backup/import", {
        content: importText,
        format: importFormat,
        strategy,
        confirm_replace: strategy === "replace_all",
      });
      setMsg(
        `Imported (${importFormat}/${strategy}): created ${r.created}, skipped ${r.skipped}` +
          (r.merged != null ? `, merged ${r.merged}` : ""),
      );
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {msg ? <div className="success">{msg}</div> : null}
      {err ? <div className="error">{err}</div> : null}
      <div className="stack" style={{ gap: 8 }}>
        <div className="settings-section-title">{t("export")}</div>
        <div className="muted-sm">{t("exportHint")}</div>
        <div className="row wrap">
          <button className="btn btn-soft" type="button" onClick={() => void exportFmt("json")}>
            JSON
          </button>
          <button className="btn btn-soft" type="button" onClick={() => void exportFmt("csv")}>
            CSV
          </button>
          <button className="btn btn-soft" type="button" onClick={() => void exportFmt("html")}>
            HTML
          </button>
        </div>
      </div>
      <div className="stack" style={{ gap: 8, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
        <div className="settings-section-title">{t("import")}</div>
        <div className="muted-sm">{t("importHint")}</div>
        <label
          className="stack"
          style={{
            gap: 6,
            border: "1.5px dashed var(--border)",
            borderRadius: 11,
            padding: 20,
            textAlign: "center",
            cursor: "pointer",
            color: "var(--text3)",
            fontSize: 12.5,
          }}
        >
          ⇪ {t("dropFile")}
          <input
            type="file"
            accept=".json,.csv,.html,.htm,text/html,text/csv,application/json"
            data-testid="import-file"
            style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }}
            onChange={(e) => void onFile(e.target.files?.[0] || null)}
          />
          {fileName ? <span className="muted">Selected: {fileName}</span> : null}
        </label>
        <div className="settings-grid">
          <label className="field">
            {t("dedupe")}
            <select
              className="input"
              value={strategy}
              data-testid="import-strategy"
              onChange={(e) => setStrategy(e.target.value as ImportStrategy)}
            >
              <option value="skip_duplicate">skip_duplicate</option>
              <option value="merge">merge</option>
              <option value="replace_all">replace_all</option>
            </select>
          </label>
          <label className="field">
            {t("import")}
            <select
              className="input"
              value={importFormat}
              onChange={(e) => setImportFormat(e.target.value as any)}
              data-testid="import-format"
            >
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
              <option value="html">HTML (Netscape)</option>
            </select>
          </label>
        </div>
        <textarea
          className="input"
          rows={5}
          placeholder="Paste JSON / CSV / HTML to import"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          data-testid="import-text"
        />
        <div>
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy}
            data-testid="import-submit"
            onClick={() => void doImport()}
          >
            {busy ? t("importing") : `${t("import")} ${importFormat.toUpperCase()}`}
          </button>
        </div>
      </div>
      {confirmElement}
      <Toast message={toast} />
    </>
  );
}

/* ---------- remote backup shared bits ---------- */

type RunNowResult = {
  ok: boolean;
  retention_ok?: boolean;
  retention_error?: string;
};

/** Coerce the keep_backups input string; empty/invalid → undefined (keep previous). */
function parseKeepBackups(raw: string): number | undefined {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** Persistent warning card fed by GET config; disappears once the fields are cleared. */
function RetentionWarning({ cfg, testId }: { cfg: any; testId: string }) {
  const { t } = useI18n();
  if (!cfg.last_retention_error) return null;
  return (
    <div
      className="card"
      data-testid={testId}
      style={{ borderColor: "var(--warn)", background: "rgba(217,119,6,.06)" }}
    >
      <div>
        {t("lastRetentionError")}: {cfg.last_retention_error}
      </div>
      <div className="muted-sm">
        {cfg.last_retention_error_at ? cfg.last_retention_error_at : null}
        {cfg.last_retention_failed != null ? ` · ${t("failed")}: ${cfg.last_retention_failed}` : null}
      </div>
    </div>
  );
}

/* ---------- webdav ---------- */

function WebdavSection() {
  const { api } = useAuth();
  const { t } = useI18n();
  const { toast, showToast } = useToast();
  const [webdav, setWebdav] = useState<any>({});
  const [keepInput, setKeepInput] = useState("");

  async function refresh() {
    const r = await api.get<any>("/backup/webdav");
    setWebdav(r);
    setKeepInput(r.keep_backups != null ? String(r.keep_backups) : "");
  }

  useEffect(() => {
    void refresh();
  }, [api]);

  async function save() {
    const body = { ...webdav };
    const keep = parseKeepBackups(keepInput);
    if (keep != null) body.keep_backups = keep;
    const r = await api.put<any>("/backup/webdav", body);
    setWebdav(r);
    setKeepInput(r.keep_backups != null ? String(r.keep_backups) : "");
    showToast(`WebDAV ${t("save")} ✓`);
  }

  async function runNow() {
    try {
      const r = await api.post<RunNowResult>("/backup/webdav");
      if (r.retention_ok === false) {
        showToast(
          `${t("retentionPartialFailed")}${r.retention_error ? `: ${r.retention_error}` : ""}`,
        );
      } else {
        showToast("WebDAV ✓");
      }
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  }

  async function test() {
    const r = await api.get<{ ok: boolean; message?: string }>("/backup/webdav?test=true");
    showToast(r.ok ? "WebDAV OK" : `WebDAV: ${r.message}`);
  }

  return (
    <div className="stack">
      <div className="row">
        <div className="settings-section-title">WebDAV</div>
        <span className="spacer">
          <Switch
            checked={!!webdav.enabled}
            onChange={(v) => setWebdav({ ...webdav, enabled: v })}
            label={t("enabled")}
          />
        </span>
      </div>
      <label className="field">
        URL
        <input
          className="input input-mono"
          placeholder="https://dav.example.com/remote.php/dav"
          value={webdav.url || ""}
          onChange={(e) => setWebdav({ ...webdav, url: e.target.value })}
        />
      </label>
      <div className="settings-grid">
        <label className="field">
          {t("username")}
          <input
            className="input input-mono"
            value={webdav.username || ""}
            onChange={(e) => setWebdav({ ...webdav, username: e.target.value })}
          />
        </label>
        <label className="field">
          {t("password")}
          <input
            className="input input-mono"
            type="password"
            placeholder={webdav.password_set ? `${t("password")} ${t("keepBlank")}` : ""}
            onChange={(e) => setWebdav({ ...webdav, password: e.target.value })}
          />
        </label>
      </div>
      <label className="field">
        Path
        <input
          className="input input-mono"
          placeholder="/markhub"
          value={webdav.path || ""}
          onChange={(e) => setWebdav({ ...webdav, path: e.target.value })}
        />
      </label>
      <div className="settings-grid">
        <label className="field">
          {t("backupTime")} (HH:mm)
          <input
            className="input input-mono"
            placeholder="02:00"
            value={webdav.backup_time || ""}
            data-testid="webdav-backup-time"
            onChange={(e) => setWebdav({ ...webdav, backup_time: e.target.value })}
          />
        </label>
        <label className="field">
          {t("keepBackups")}
          <input
            className="input input-mono"
            type="number"
            min={1}
            step={1}
            value={keepInput}
            data-testid="webdav-keep-backups"
            onChange={(e) => setKeepInput(e.target.value)}
          />
        </label>
      </div>
      <RetentionWarning cfg={webdav} testId="webdav-retention-warning" />
      <div className="row">
        <button className="btn btn-soft" type="button" onClick={() => void test()}>
          {t("testConn")}
        </button>
        <button className="btn" type="button" onClick={() => void runNow()}>
          {t("runNow")}
        </button>
        <button className="btn btn-primary" type="button" onClick={() => void save()}>
          {t("save")}
        </button>
      </div>
      {webdav.last_backup_at ? (
        <div className="muted">
          {t("lastBackup")}: {webdav.last_backup_at}
        </div>
      ) : null}
      <Toast message={toast} />
    </div>
  );
}

/* ---------- s3 ---------- */

function S3Section() {
  const { api } = useAuth();
  const { t } = useI18n();
  const { toast, showToast } = useToast();
  const [s3, setS3] = useState<any>({});
  const [keepInput, setKeepInput] = useState("");

  async function refresh() {
    const r = await api.get<any>("/backup/s3");
    setS3(r);
    setKeepInput(r.keep_backups != null ? String(r.keep_backups) : "");
  }

  useEffect(() => {
    void refresh();
  }, [api]);

  async function save() {
    const body = { ...s3 };
    const keep = parseKeepBackups(keepInput);
    if (keep != null) body.keep_backups = keep;
    const r = await api.put<any>("/backup/s3", body);
    setS3(r);
    setKeepInput(r.keep_backups != null ? String(r.keep_backups) : "");
    showToast(`S3 ${t("save")} ✓`);
  }

  async function runNow() {
    try {
      const r = await api.post<RunNowResult>("/backup/s3");
      if (r.retention_ok === false) {
        showToast(
          `${t("retentionPartialFailed")}${r.retention_error ? `: ${r.retention_error}` : ""}`,
        );
      } else {
        showToast("S3 ✓");
      }
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  }

  async function test() {
    const r = await api.get<{ ok: boolean; message?: string; latency_ms?: number }>(
      "/backup/s3?test=true",
    );
    showToast(r.ok ? `S3 OK (${r.latency_ms}ms)` : `S3: ${r.message}`);
  }

  return (
    <div className="stack">
      <div className="row">
        <div className="settings-section-title">S3 / Cloudflare R2</div>
        <span className="spacer">
          <Switch
            checked={!!s3.enabled}
            onChange={(v) => setS3({ ...s3, enabled: v })}
            label={t("enabled")}
          />
        </span>
      </div>
      <label className="field">
        Endpoint
        <input
          className="input input-mono"
          placeholder="https://<account>.r2.cloudflarestorage.com"
          value={s3.endpoint || ""}
          onChange={(e) => setS3({ ...s3, endpoint: e.target.value })}
        />
      </label>
      <div className="settings-grid">
        <label className="field">
          Region
          <input
            className="input input-mono"
            placeholder="auto"
            value={s3.region || ""}
            onChange={(e) => setS3({ ...s3, region: e.target.value })}
          />
        </label>
        <label className="field">
          Bucket
          <input
            className="input input-mono"
            value={s3.bucket || ""}
            onChange={(e) => setS3({ ...s3, bucket: e.target.value })}
          />
        </label>
        <label className="field">
          Key prefix
          <input
            className="input input-mono"
            value={s3.key_prefix || ""}
            onChange={(e) => setS3({ ...s3, key_prefix: e.target.value })}
          />
        </label>
        <label className="field">
          {t("backupTime")} (HH:mm)
          <input
            className="input input-mono"
            placeholder="02:00"
            value={s3.backup_time || ""}
            data-testid="s3-backup-time"
            onChange={(e) => setS3({ ...s3, backup_time: e.target.value })}
          />
        </label>
        <label className="field">
          {t("keepBackups")}
          <input
            className="input input-mono"
            type="number"
            min={1}
            step={1}
            value={keepInput}
            data-testid="s3-keep-backups"
            onChange={(e) => setKeepInput(e.target.value)}
          />
        </label>
        <label className="field">
          Access key ID
          <input
            className="input input-mono"
            value={s3.access_key_id || ""}
            onChange={(e) => setS3({ ...s3, access_key_id: e.target.value })}
          />
        </label>
        <label className="field">
          Secret access key
          <input
            className="input input-mono"
            type="password"
            placeholder={s3.secret_set ? `${t("keepBlank")}` : ""}
            onChange={(e) => setS3({ ...s3, secret_access_key: e.target.value })}
          />
        </label>
      </div>
      <RetentionWarning cfg={s3} testId="s3-retention-warning" />
      <div className="row">
        <button className="btn btn-soft" type="button" onClick={() => void test()}>
          {t("testConn")}
        </button>
        <button className="btn" type="button" onClick={() => void runNow()}>
          {t("runNow")}
        </button>
        <button className="btn btn-primary" type="button" onClick={() => void save()}>
          {t("save")}
        </button>
      </div>
      {s3.last_backup_at ? (
        <div className="muted">
          {t("lastBackup")}: {s3.last_backup_at}
        </div>
      ) : null}
      <Toast message={toast} />
    </div>
  );
}
