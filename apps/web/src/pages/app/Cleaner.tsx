import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";
import { DomainBar, PageHeader, Spinner, StatCard } from "../../components/ui";

type CleanJob = {
  id: string;
  status: string;
  progress?: number;
  error?: string | null;
  issues?: any[];
  issue_count?: number;
};

const KIND_META: Record<
  string,
  { titleZh: string; titleEn: string; dot: string; badge: string; fg: string; bg: string }
> = {
  invalid: {
    titleZh: "失效链接",
    titleEn: "Invalid links",
    dot: "var(--bad)",
    badge: "HTTP",
    fg: "#dc2626",
    bg: "rgba(220,38,38,.1)",
  },
  dead: {
    titleZh: "失效链接",
    titleEn: "Invalid links",
    dot: "var(--bad)",
    badge: "dead",
    fg: "#dc2626",
    bg: "rgba(220,38,38,.1)",
  },
  duplicate: {
    titleZh: "重复书签",
    titleEn: "Duplicates",
    dot: "var(--warn)",
    badge: "normalizeUrl",
    fg: "#d97706",
    bg: "rgba(217,119,6,.1)",
  },
  empty: {
    titleZh: "空文件夹",
    titleEn: "Empty folders",
    dot: "#7c3aed",
    badge: "count=0",
    fg: "#7c3aed",
    bg: "rgba(124,58,237,.1)",
  },
  empty_folder: {
    titleZh: "空文件夹",
    titleEn: "Empty folders",
    dot: "#7c3aed",
    badge: "count=0",
    fg: "#7c3aed",
    bg: "rgba(124,58,237,.1)",
  },
  broken: {
    titleZh: "异常 URL",
    titleEn: "Broken URLs",
    dot: "#64748b",
    badge: "parse error",
    fg: "#64748b",
    bg: "rgba(100,116,139,.12)",
  },
};

export function CleanerPage() {
  const { api } = useAuth();
  const { t, lang } = useI18n();
  const [job, setJob] = useState<CleanJob | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [checkInvalid, setCheckInvalid] = useState(false);
  const [polling, setPolling] = useState(false);
  const [profile, setProfile] = useState<any>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    void api.get("/analytics/profile").then(setProfile).catch(() => setProfile(null));
    return () => {
      cancelled.current = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [api]);

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
        if (status !== "done") setErr(r.error || `Job ${status}`);
        void api.get("/analytics/profile").then(setProfile).catch(() => null);
        return;
      }
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
    setMsg(
      lang === "zh"
        ? `已软删除 ${r.applied} 项`
        : `Applied soft-delete to ${r.applied} items`,
    );
    if (job?.id) setJob(await api.get(`/clean/jobs/${job.id}`));
    setSelected(new Set());
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
  const progress = typeof job?.progress === "number" ? Math.round(job.progress * 100) : 0;

  const groups = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const iss of issues) {
      const kind = String(iss.kind || "broken").toLowerCase();
      const list = map.get(kind) || [];
      list.push(iss);
      map.set(kind, list);
    }
    return [...map.entries()].map(([kind, items]) => {
      const meta = KIND_META[kind] || KIND_META.broken;
      return {
        kind,
        title: lang === "zh" ? meta.titleZh : meta.titleEn,
        dot: meta.dot,
        badge: meta.badge,
        fg: meta.fg,
        bg: meta.bg,
        items,
      };
    });
  }, [issues, lang]);

  const topDomains: any[] = profile?.top_domains || [];
  const maxDom = topDomains.reduce(
    (m: number, d: any) => Math.max(m, d.n || d.count || 0),
    0,
  );

  const deadCount = issues.filter((i) =>
    ["invalid", "dead", "broken"].includes(String(i.kind || "").toLowerCase()),
  ).length;
  const dupCount = issues.filter((i) => String(i.kind || "").toLowerCase() === "duplicate").length;

  return (
    <div style={{ maxWidth: 980 }}>
      <PageHeader
        title={t("cleaner")}
        sub={t("cleanerSub")}
        actions={
          <div className="row">
            <label className="row" style={{ fontSize: 12.5, color: "var(--text2)" }}>
              <input
                type="checkbox"
                checked={checkInvalid}
                onChange={(e) => setCheckInvalid(e.target.checked)}
              />
              {t("networkCheck")}
            </label>
            <button
              className="btn btn-primary"
              type="button"
              disabled={isRunning}
              onClick={() => void run()}
            >
              {isRunning ? t("scanning").split("：")[0] || "…" : t("startScan")}
            </button>
          </div>
        }
      />

      <div className="stat-grid" style={{ marginBottom: 18 }}>
        <StatCard label={t("totalBm")} value={profile?.total_bookmarks ?? "—"} />
        <StatCard
          label={t("deadPending")}
          value={deadCount || profile?.dead_links || 0}
          deltaColor="var(--bad)"
        />
        <StatCard label={t("dupCount")} value={dupCount || 0} deltaColor="var(--warn)" />
        <StatCard label={t("added30")} value={profile?.added_last_30_days ?? "—"} />
      </div>

      {isRunning ? (
        <div className="card row" style={{ marginBottom: 16, gap: 14 }}>
          <Spinner />
          <div className="grow">
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("scanning")}</div>
            <div className="progress-track">
              <div className="progress-bar" style={{ width: `${progress || 12}%` }} />
            </div>
          </div>
          <span className="mono">{progress || 0}%</span>
        </div>
      ) : null}

      {msg ? <div className="success" style={{ marginBottom: 12 }}>{msg}</div> : null}
      {err ? <div className="error" style={{ marginBottom: 12 }}>{err}</div> : null}

      {groups.length ? (
        <div className="stack" style={{ gap: 14 }}>
          {groups.map((g) => (
            <div key={g.kind} className="card card-flush">
              <div className="row" style={{ gap: 10, padding: "13px 16px", borderBottom: "1px solid var(--border)" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: g.dot }} />
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{g.title}</span>
                <span className="muted-sm">
                  {g.items.length} {lang === "zh" ? "项" : "issues"}
                </span>
              </div>
              {g.items.map((iss: any) => {
                const checked = selected.has(iss.id);
                return (
                  <div
                    key={iss.id}
                    className="list-row clickable"
                    onClick={() => !iss.resolved && !isRunning && toggle(iss.id)}
                  >
                    <span
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 5,
                        border: `1.5px solid ${checked ? "var(--accent)" : "var(--border)"}`,
                        background: checked ? "var(--accent)" : "transparent",
                        color: "#fff",
                        fontSize: 11,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flex: "none",
                      }}
                    >
                      {checked ? "✓" : ""}
                    </span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>
                        {iss.title || iss.entity_type || iss.kind}
                      </div>
                      <div className="mono">
                        {iss.detail ||
                          `${iss.entity_type || ""}:${String(iss.entity_id || "").slice(0, 8)}`}
                      </div>
                    </div>
                    <span
                      className="badge"
                      style={{ color: g.fg, background: g.bg, flex: "none" }}
                    >
                      {iss.badge || g.badge}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
          <div className="card row">
            <span style={{ fontSize: 12.5, color: "var(--text2)" }}>
              {selected.size} {lang === "zh" ? "项已选" : "selected"}
            </span>
            <button
              className="btn btn-danger spacer"
              type="button"
              disabled={!canApply}
              onClick={() => void apply()}
            >
              {t("applyClean")}
            </button>
          </div>
        </div>
      ) : !isRunning && job ? (
        <div className="empty-state">{t("noIssues")}</div>
      ) : !job ? (
        <div className="muted" style={{ marginBottom: 22 }}>
          {t("runScanHint")}
        </div>
      ) : null}

      {topDomains.length ? (
        <div className="card" style={{ marginTop: 22 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 12 }}>{t("topDomains")}</div>
          <div className="stack" style={{ gap: 9 }}>
            {topDomains.slice(0, 8).map((d: any) => (
              <DomainBar
                key={d.domain || d.host}
                host={d.domain || d.host}
                n={d.count ?? d.n ?? 0}
                max={maxDom || 1}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
