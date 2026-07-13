import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";

type CleanJob = {
  id: string;
  status: string;
  progress?: number;
  error?: string | null;
  issues?: any[];
  issue_count?: number;
};

export function CleanerPage() {
  const { api } = useAuth();
  const { t } = useI18n();
  const [job, setJob] = useState<CleanJob | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [checkInvalid, setCheckInvalid] = useState(false);
  const [polling, setPolling] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  async function pollJob(jobId: string, attempt = 0) {
    if (cancelled.current) return;
    setPolling(true);
    try {
      const r = await api.get<CleanJob>(`/clean/jobs/${jobId}`);
      if (cancelled.current) return;
      setJob(r);
      const status = (r.status || "").toLowerCase();
      if (status === "done" || status === "failed" || status === "error") {
        setPolling(false);
        if (status !== "done") {
          setErr(r.error || `Job ${status}`);
        }
        return;
      }
      // Backoff: 400ms → ~5s cap
      const delay = Math.min(400 * Math.pow(1.5, attempt), 5000);
      pollTimer.current = setTimeout(() => void pollJob(jobId, attempt + 1), delay);
    } catch (e: any) {
      if (cancelled.current) return;
      setPolling(false);
      setErr(String(e?.message || e));
    }
  }

  async function run() {
    setMsg("");
    setErr("");
    if (pollTimer.current) clearTimeout(pollTimer.current);
    const r = await api.post<CleanJob>("/clean/jobs", {
      check_invalid: checkInvalid,
      concurrency: 8,
    });
    setJob(r);
    setSelected(new Set());
    const status = (r.status || "").toLowerCase();
    if (status === "pending" || status === "running" || status === "queued") {
      void pollJob(r.id);
    }
  }

  async function apply() {
    const r = await api.post<{ applied: number }>("/clean/apply", {
      issue_ids: [...selected],
      mark_link_status: true,
    });
    setMsg(`Applied soft-delete to ${r.applied} items`);
    if (job?.id) setJob(await api.get(`/clean/jobs/${job.id}`));
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const status = (job?.status || "").toLowerCase();
  const isRunning = polling || status === "pending" || status === "running" || status === "queued";
  const issues = job?.issues || [];
  const canApply = !isRunning && status === "done" && selected.size > 0;

  return (
    <div className="stack">
      <h1 className="page-title">{t("cleaner")}</h1>
      <div className="card row">
        <label className="row">
          <input
            type="checkbox"
            checked={checkInvalid}
            onChange={(e) => setCheckInvalid(e.target.checked)}
          />
          Network invalid check
        </label>
        <button className="btn btn-primary" type="button" disabled={isRunning} onClick={() => void run()}>
          {isRunning ? "Scanning…" : "Scan"}
        </button>
        <button className="btn" type="button" disabled={!canApply} onClick={() => void apply()}>
          Soft-delete selected ({selected.size})
        </button>
      </div>
      {job ? (
        <div className="muted">
          Job {job.id.slice(0, 8)} · status={job.status}
          {typeof job.progress === "number" ? ` · progress=${Math.round(job.progress * 100)}%` : ""}
        </div>
      ) : null}
      {msg ? <div className="success">{msg}</div> : null}
      {err ? <div className="error">{err}</div> : null}
      {job ? (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>Kind</th>
                <th>Entity</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((i: any) => (
                <tr key={i.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(i.id)}
                      onChange={() => toggle(i.id)}
                      disabled={i.resolved || isRunning}
                    />
                  </td>
                  <td>
                    <span className="badge">{i.kind}</span>
                  </td>
                  <td>
                    {i.entity_type}:{String(i.entity_id || "").slice(0, 8)}
                  </td>
                  <td className="muted">{i.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!issues.length && !isRunning ? (
            <div className="muted" style={{ padding: 16 }}>
              No issues found.
            </div>
          ) : null}
        </div>
      ) : (
        <div className="muted">Run a scan to find duplicates, empty folders, broken URLs.</div>
      )}
    </div>
  );
}
