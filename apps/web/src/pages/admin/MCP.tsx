import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";
import { PageHeader, Switch } from "../../components/ui";

const MCP_TOOLS = [
  { name: "list_markhub_folders", descZh: "文件夹树", descEn: "Folder tree" },
  { name: "list_markhub_bookmarks", descZh: "书签列表", descEn: "List bookmarks" },
  { name: "create_markhub_bookmark", descZh: "创建书签", descEn: "Create bookmark" },
  { name: "search_markhub", descZh: "全文搜索", descEn: "Full-text search" },
  { name: "get_markhub_profile", descZh: "库统计", descEn: "Library stats" },
  { name: "run_markhub_clean", descZh: "触发清理扫描", descEn: "Trigger clean scan" },
];

export function AdminMCP() {
  const { api } = useAuth();
  const { t, lang } = useI18n();
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
    setMsg(t("save"));
  }

  async function rotate() {
    const r = await api.post<{ token: string }>("/settings/mcp/token");
    setToken(r.token);
    setCfg(await api.get("/settings/mcp"));
    setMsg(lang === "zh" ? "新 Token 已生成 — 请立即复制" : "New token generated — copy it now");
  }

  async function copyToken() {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setMsg(lang === "zh" ? "已复制" : "Copied");
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader title="MCP" />
      <div className="card stack" style={{ marginBottom: 16, padding: 20 }}>
        <div className="row" style={{ gap: 12 }}>
          <div className="grow">
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t("mcpEnable")}</div>
            <div className="muted-sm" style={{ marginTop: 3 }}>
              Streamable HTTP · Bearer Token / OAuth Client Credentials
            </div>
          </div>
          <Switch
            on={!!cfg.enabled}
            onChange={(v) => setCfg({ ...cfg, enabled: v })}
            label={t("mcpEnable")}
          />
        </div>
        {cfg.enabled ? (
          <>
            <div className="row" style={{ gap: 8 }}>
              <span
                className="mono grow"
                style={{
                  background: "var(--panel2)",
                  borderRadius: 8,
                  padding: "9px 13px",
                  color: "var(--text2)",
                  wordBreak: "break-all",
                }}
              >
                {token || (cfg.token_set ? "mcp_sk_•••••••• (set)" : "—")}
              </span>
              <button type="button" className="btn btn-soft btn-sm" onClick={() => void rotate()}>
                {t("rotate")}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void copyToken()} disabled={!token}>
                {t("copy")}
              </button>
            </div>
            <div className="mono">POST https://your-host/mcp</div>
          </>
        ) : null}
        <label className="field">
          Allowed origins
          <input
            className="input"
            value={cfg.allowed_origins || ""}
            onChange={(e) => setCfg({ ...cfg, allowed_origins: e.target.value })}
          />
        </label>
        <div className="row">
          <button className="btn btn-primary" type="button" onClick={() => void save()}>
            {t("save")}
          </button>
        </div>
        {msg ? <div className="success">{msg}</div> : null}
      </div>

      <div className="card card-flush">
        <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--border)", fontWeight: 600, fontSize: 13.5 }}>
          {t("mcpTools")}
        </div>
        {MCP_TOOLS.map((tl) => (
          <div key={tl.name} className="list-row">
            <span className="mono" style={{ color: "var(--accent-text)", flex: "none" }}>
              {tl.name}
            </span>
            <span className="muted-sm" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {lang === "zh" ? tl.descZh : tl.descEn}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
