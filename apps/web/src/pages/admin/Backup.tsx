import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";

type ImportStrategy = "skip_duplicate" | "merge" | "replace_all";

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

export function AdminBackup() {
  const { api } = useAuth();
  const { t } = useI18n();
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [s3, setS3] = useState<any>({});
  const [webdav, setWebdav] = useState<any>({});
  const [importText, setImportText] = useState("");
  const [importFormat, setImportFormat] = useState<"json" | "csv" | "html">("json");
  const [strategy, setStrategy] = useState<ImportStrategy>("skip_duplicate");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get("/backup/s3").then(setS3);
    void api.get("/backup/webdav").then(setWebdav);
  }, [api]);

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
      const ok = window.confirm(
        "Replace ALL existing bookmarks with this import? Soft-deleted rows can be recovered for 30 days. Continue?",
      );
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

  async function saveS3() {
    const r = await api.put("/backup/s3", s3);
    setS3(r);
    setMsg("S3 config saved");
  }

  async function testS3() {
    const r = await api.get<{ ok: boolean; message?: string; latency_ms?: number }>(
      "/backup/s3?test=true",
    );
    setMsg(r.ok ? `S3 OK (${r.latency_ms}ms)` : `S3 fail: ${r.message}`);
  }

  async function saveWebdav() {
    const r = await api.put("/backup/webdav", webdav);
    setWebdav(r);
    setMsg("WebDAV config saved");
  }

  async function testWebdav() {
    const r = await api.get<{ ok: boolean; message?: string }>("/backup/webdav?test=true");
    setMsg(r.ok ? "WebDAV OK" : `WebDAV fail: ${r.message}`);
  }

  return (
    <div className="stack">
      <h1 className="page-title">{t("backup")}</h1>
      {msg ? <div className="success">{msg}</div> : null}
      {err ? <div className="error">{err}</div> : null}

      <div className="card stack">
        <h3>File export / import</h3>
        <div className="row wrap">
          <button className="btn" type="button" onClick={() => void exportFmt("json")}>
            Export JSON
          </button>
          <button className="btn" type="button" onClick={() => void exportFmt("csv")}>
            Export CSV
          </button>
          <button className="btn" type="button" onClick={() => void exportFmt("html")}>
            Export HTML
          </button>
        </div>

        <label className="stack" style={{ gap: 6 }}>
          <span>Import file (JSON / CSV / Netscape HTML)</span>
          <input
            type="file"
            accept=".json,.csv,.html,.htm,text/html,text/csv,application/json"
            data-testid="import-file"
            onChange={(e) => void onFile(e.target.files?.[0] || null)}
          />
          {fileName ? <span className="muted">Selected: {fileName}</span> : null}
        </label>

        <div className="row wrap">
          <label>
            Format
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
          <label>
            Strategy
            <select
              className="input"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as ImportStrategy)}
              data-testid="import-strategy"
            >
              <option value="skip_duplicate">skip_duplicate</option>
              <option value="merge">merge</option>
              <option value="replace_all">replace_all (confirm)</option>
            </select>
          </label>
        </div>

        <textarea
          className="input"
          rows={6}
          placeholder="Paste JSON / CSV / HTML to import, or choose a file above"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          data-testid="import-text"
        />
        <button
          className="btn btn-primary"
          type="button"
          disabled={busy}
          data-testid="import-submit"
          onClick={() => void doImport()}
        >
          {busy ? "Importing…" : `${t("import")} ${importFormat.toUpperCase()}`}
        </button>
      </div>

      <div className="card stack">
        <h3>S3 / R2 backup</h3>
        <label className="row">
          <input
            type="checkbox"
            checked={!!s3.enabled}
            onChange={(e) => setS3({ ...s3, enabled: e.target.checked })}
          />
          Enabled
        </label>
        <input className="input" placeholder="endpoint" value={s3.endpoint || ""} onChange={(e) => setS3({ ...s3, endpoint: e.target.value })} />
        <input className="input" placeholder="region (auto)" value={s3.region || ""} onChange={(e) => setS3({ ...s3, region: e.target.value })} />
        <input className="input" placeholder="bucket" value={s3.bucket || ""} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} />
        <input className="input" placeholder="key_prefix" value={s3.key_prefix || ""} onChange={(e) => setS3({ ...s3, key_prefix: e.target.value })} />
        <input className="input" placeholder="access_key_id" value={s3.access_key_id || ""} onChange={(e) => setS3({ ...s3, access_key_id: e.target.value })} />
        <input className="input" type="password" placeholder={s3.secret_set ? "secret set — leave blank to keep" : "secret_access_key"} onChange={(e) => setS3({ ...s3, secret_access_key: e.target.value })} />
        <input className="input" placeholder="backup_time HH:mm" value={s3.backup_time || "02:00"} onChange={(e) => setS3({ ...s3, backup_time: e.target.value })} />
        <div className="row">
          <button className="btn btn-primary" type="button" onClick={() => void saveS3()}>
            {t("save")}
          </button>
          <button className="btn" type="button" onClick={() => void testS3()}>
            Test connection
          </button>
          <button className="btn" type="button" onClick={() => void api.post("/backup/s3").then(() => setMsg("S3 backup started/done"))}>
            Run now
          </button>
        </div>
        {s3.last_backup_at ? <div className="muted">Last: {s3.last_backup_at}</div> : null}
      </div>

      <div className="card stack">
        <h3>WebDAV backup</h3>
        <label className="row">
          <input type="checkbox" checked={!!webdav.enabled} onChange={(e) => setWebdav({ ...webdav, enabled: e.target.checked })} />
          Enabled
        </label>
        <input className="input" placeholder="url" value={webdav.url || ""} onChange={(e) => setWebdav({ ...webdav, url: e.target.value })} />
        <input className="input" placeholder="username" value={webdav.username || ""} onChange={(e) => setWebdav({ ...webdav, username: e.target.value })} />
        <input className="input" type="password" placeholder={webdav.password_set ? "password set — leave blank to keep" : "password"} onChange={(e) => setWebdav({ ...webdav, password: e.target.value })} />
        <input className="input" placeholder="path" value={webdav.path || ""} onChange={(e) => setWebdav({ ...webdav, path: e.target.value })} />
        <div className="row">
          <button className="btn btn-primary" type="button" onClick={() => void saveWebdav()}>
            {t("save")}
          </button>
          <button className="btn" type="button" onClick={() => void testWebdav()}>
            Test connection
          </button>
          <button className="btn" type="button" onClick={() => void api.post("/backup/webdav").then(() => setMsg("WebDAV backup done"))}>
            Run now
          </button>
        </div>
      </div>
    </div>
  );
}
