import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";

export function AdminMCP() {
  const { api } = useAuth();
  const [cfg, setCfg] = useState<any>({});
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    void api.get("/settings/mcp").then(setCfg);
  }, [api]);

  async function save() {
    const r = await api.put("/settings/mcp", {
      enabled: cfg.enabled,
      allowed_origins: cfg.allowed_origins,
    });
    setCfg(r);
    setMsg("Saved");
  }

  async function rotate() {
    const r = await api.post<{ token: string }>("/settings/mcp/token");
    setToken(r.token);
    setCfg(await api.get("/settings/mcp"));
    setMsg("New token generated — copy it now");
  }

  return (
    <div className="stack">
      <h1 className="page-title">MCP</h1>
      <div className="card stack">
        <label className="row">
          <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
          Enabled
        </label>
        <input
          className="input"
          placeholder="allowed origins"
          value={cfg.allowed_origins || ""}
          onChange={(e) => setCfg({ ...cfg, allowed_origins: e.target.value })}
        />
        <div className="muted">Token set: {cfg.token_set ? "yes" : "no"}</div>
        {token ? (
          <code style={{ wordBreak: "break-all", fontFamily: "var(--mono)", fontSize: 12 }}>{token}</code>
        ) : null}
        <div className="row">
          <button className="btn btn-primary" type="button" onClick={() => void save()}>
            Save
          </button>
          <button className="btn" type="button" onClick={() => void rotate()}>
            Rotate token
          </button>
        </div>
        {msg ? <div className="success">{msg}</div> : null}
        <p className="muted">Endpoints: GET /api/v1/mcp/tools · POST /api/v1/mcp/call (Bearer MCP token)</p>
      </div>
    </div>
  );
}
