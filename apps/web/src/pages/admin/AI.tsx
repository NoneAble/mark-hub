import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";

export function AdminAI() {
  const { api } = useAuth();
  const [cfg, setCfg] = useState<any>({});
  const [status, setStatus] = useState<any>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [bookmarks, setBookmarks] = useState<any[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [classifyUrl, setClassifyUrl] = useState("https://example.com");
  const [classifyTitle, setClassifyTitle] = useState("Example");
  const [summarizeUrl, setSummarizeUrl] = useState("https://example.com");
  const [summarizeTitle, setSummarizeTitle] = useState("Example");
  const [quickUrl, setQuickUrl] = useState("");
  const [task, setTask] = useState<any>(null);
  const [tasks, setTasks] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [toolResult, setToolResult] = useState("");

  useEffect(() => {
    void api.get("/settings/ai").then(setCfg);
    void api.get("/ai/status").then(setStatus);
    void api
      .get<{ items: any[] }>("/bookmarks?limit=100")
      .then((r) => setBookmarks(r.items || []))
      .catch(() => setBookmarks([]));
    void api
      .get<{ items: any[] }>("/ai/tasks")
      .then((r) => setTasks(r.items || []))
      .catch(() => setTasks([]));
  }, [api]);

  async function save() {
    const r = await api.put("/settings/ai", cfg);
    setCfg(r);
    setMsg("Saved");
    setStatus(await api.get("/ai/status"));
  }

  async function test() {
    const r = await api.post<{ ok: boolean; message?: string; reply?: string }>("/settings/ai/test");
    setMsg(r.ok ? `OK: ${r.reply}` : `Fail: ${r.message}`);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function runClassify() {
    setErr("");
    setBusy(true);
    try {
      const r = await api.post<any>("/ai/classify", {
        title: classifyTitle,
        url: classifyUrl,
        description: "",
      });
      setToolResult(JSON.stringify(r, null, 2));
      setMsg("Classify done");
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runSummarize() {
    setErr("");
    setBusy(true);
    try {
      const r = await api.post<any>("/ai/summarize", {
        title: summarizeTitle,
        url: summarizeUrl,
        description: "",
      });
      setToolResult(JSON.stringify(r, null, 2));
      setMsg("Summarize done");
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runQuick(kind: "plain" | "title" | "category") {
    if (!quickUrl.trim()) {
      setErr("URL required for quick-add");
      return;
    }
    setErr("");
    setBusy(true);
    try {
      const path =
        kind === "title"
          ? "/ai/quick-add/with-title"
          : kind === "category"
            ? "/ai/quick-add/with-category"
            : "/ai/quick-add";
      const r = await api.post<any>(path, { url: quickUrl.trim() });
      setToolResult(JSON.stringify(r, null, 2));
      setMsg(`Quick-add (${kind}) done`);
      setBookmarks((await api.get<{ items: any[] }>("/bookmarks?limit=100")).items || []);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runBatch(actions: string[]) {
    if (!selected.size) {
      setErr("Select at least one bookmark");
      return;
    }
    setErr("");
    setBusy(true);
    setTask(null);
    try {
      const created = await api.post<any>("/ai/batch", {
        bookmark_ids: [...selected],
        actions,
      });
      setTask(created);
      setMsg(`Batch task ${created.id} · ${created.status}`);
      // Poll until done/failed (or timeout)
      const id = created.id;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const t = await api.get<any>(`/ai/tasks/${id}`);
          setTask(t);
          if (t.status === "done" || t.status === "failed") {
            setMsg(`Batch ${t.status}${t.error ? `: ${t.error}` : ""}`);
            break;
          }
        } catch {
          // Worker may return completed payload immediately without task store race
          break;
        }
      }
      setTasks((await api.get<{ items: any[] }>("/ai/tasks")).items || []);
      setBookmarks((await api.get<{ items: any[] }>("/bookmarks?limit=100")).items || []);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <h1 className="page-title">AI settings</h1>
      {msg ? <div className="success">{msg}</div> : null}
      {err ? <div className="error">{err}</div> : null}

      <div className="card stack">
        <div className="muted">
          Status: {status?.configured ? "configured" : "not configured"} · model {status?.model}
        </div>
        <input
          className="input"
          placeholder="base url"
          value={cfg.ai_base_url || ""}
          onChange={(e) => setCfg({ ...cfg, ai_base_url: e.target.value })}
        />
        <input
          className="input"
          placeholder="model"
          value={cfg.ai_model || ""}
          onChange={(e) => setCfg({ ...cfg, ai_model: e.target.value })}
        />
        <input
          className="input"
          type="password"
          placeholder={cfg.ai_api_key_set ? "API key set — enter new to rotate" : "API key"}
          onChange={(e) => setCfg({ ...cfg, ai_api_key: e.target.value })}
        />
        <div className="row">
          <button className="btn btn-primary" type="button" onClick={() => void save()}>
            Save
          </button>
          <button className="btn" type="button" onClick={() => void test()}>
            Test
          </button>
        </div>
      </div>

      <div className="card stack">
        <h3>Classify</h3>
        <input
          className="input"
          placeholder="title"
          value={classifyTitle}
          onChange={(e) => setClassifyTitle(e.target.value)}
          data-testid="ai-classify-title"
        />
        <input
          className="input"
          placeholder="url"
          value={classifyUrl}
          onChange={(e) => setClassifyUrl(e.target.value)}
          data-testid="ai-classify-url"
        />
        <button className="btn" type="button" disabled={busy} data-testid="ai-classify" onClick={() => void runClassify()}>
          Classify
        </button>
      </div>

      <div className="card stack">
        <h3>Summarize</h3>
        <input
          className="input"
          placeholder="title"
          value={summarizeTitle}
          onChange={(e) => setSummarizeTitle(e.target.value)}
        />
        <input
          className="input"
          placeholder="url"
          value={summarizeUrl}
          onChange={(e) => setSummarizeUrl(e.target.value)}
        />
        <button className="btn" type="button" disabled={busy} data-testid="ai-summarize" onClick={() => void runSummarize()}>
          Summarize
        </button>
      </div>

      <div className="card stack">
        <h3>Quick add</h3>
        <input
          className="input"
          placeholder="https://…"
          value={quickUrl}
          onChange={(e) => setQuickUrl(e.target.value)}
          data-testid="ai-quick-url"
        />
        <div className="row wrap">
          <button className="btn" type="button" disabled={busy} onClick={() => void runQuick("plain")}>
            Quick add
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => void runQuick("title")}>
            With title
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => void runQuick("category")}>
            With category
          </button>
        </div>
      </div>

      <div className="card stack">
        <h3>Batch on bookmarks</h3>
        <div className="muted">Select bookmarks, then run summarize / classify.</div>
        <div style={{ maxHeight: 220, overflow: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>Title</th>
                <th>URL</th>
              </tr>
            </thead>
            <tbody>
              {bookmarks.map((b) => (
                <tr key={b.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(b.id)}
                      onChange={() => toggle(b.id)}
                      data-testid={`ai-bm-${b.id}`}
                    />
                  </td>
                  <td>{b.title}</td>
                  <td className="muted">{b.url}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row wrap">
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy}
            data-testid="ai-batch-summarize"
            onClick={() => void runBatch(["summarize"])}
          >
            Batch summarize
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => void runBatch(["classify"])}
          >
            Batch classify
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => void runBatch(["summarize", "classify"])}
          >
            Both
          </button>
        </div>
        {task ? (
          <div className="card" data-testid="ai-task-status">
            <div>
              Task <code>{task.id}</code> · <strong>{task.status}</strong>
              {task.progress != null ? ` · progress ${task.progress}` : ""}
            </div>
            {task.error ? <div className="error">{task.error}</div> : null}
            {task.result ? (
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                {typeof task.result === "string"
                  ? task.result
                  : JSON.stringify(task.result, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}
        {tasks.length ? (
          <div className="muted">
            Recent tasks:{" "}
            {tasks
              .slice(0, 5)
              .map((t) => `${t.id.slice(0, 8)}…(${t.status})`)
              .join(", ")}
          </div>
        ) : null}
      </div>

      {toolResult ? (
        <div className="card">
          <h3>Last tool result</h3>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }} data-testid="ai-tool-result">
            {toolResult}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
