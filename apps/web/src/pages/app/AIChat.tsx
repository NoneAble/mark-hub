import { FormEvent, useEffect, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";
import { LogoMark } from "../../components/ui";

type Msg = { role: "user" | "assistant"; content: string };

const TOOLS_ZH = [
  { name: "批量分类", desc: "将收件箱书签批量归入文件夹", prompt: "帮我把收件箱分类" },
  { name: "死链清理建议", desc: "根据清理中心结果给出处理建议", prompt: "分析死链并给出清理建议" },
  { name: "标签推荐", desc: "为未打标书签推荐标签", prompt: "给没有标签的书签推荐标签" },
  { name: "本周摘要", desc: "汇总近 7 天新增书签", prompt: "总结本周新增的书签" },
];
const TOOLS_EN = [
  { name: "Batch classify", desc: "Classify inbox into folders", prompt: "Classify my inbox" },
  { name: "Dead-link advice", desc: "Suggest cleanup from scan results", prompt: "Analyze dead links and suggest cleanup" },
  { name: "Tag suggestions", desc: "Suggest tags for untagged items", prompt: "Suggest tags for untagged bookmarks" },
  { name: "Weekly summary", desc: "Summarize last 7 days", prompt: "Summarize bookmarks added this week" },
];

export function AIChatPage() {
  const { api, token } = useAuth();
  const { t, lang } = useI18n();
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      content:
        lang === "zh"
          ? "你好！我是 MarkHub AI 助手。我可以帮你整理书签、推荐分类、生成摘要。\n\n试试问我「帮我把收件箱分类」。"
          : "Hi! I'm the MarkHub AI assistant. I can organize bookmarks, suggest tags, and summarize your library.\n\nTry: “Classify my inbox”.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [quickUrl, setQuickUrl] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function sendText(text: string) {
    if (!text.trim() || loading) return;
    const next = [...messages, { role: "user" as const, content: text.trim() }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError("");
    const assistant: Msg = { role: "assistant", content: "" };
    setMessages([...next, assistant]);
    try {
      const base = (import.meta as any).env?.VITE_API_BASE || "";
      const res = await fetch(`${base}/api/v1/ai/chat?stream=true`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ messages: next }),
      });
      if (!res.ok) {
        const r = await api.post<{ reply: string }>("/ai/chat?stream=false", {
          messages: next,
        });
        setMessages([...next, { role: "assistant", content: r.reply }]);
        return;
      }
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("text/event-stream")) {
        const data = (await res.json()) as { reply?: string };
        setMessages([...next, { role: "assistant", content: data.reply || "" }]);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");
      const dec = new TextDecoder();
      let buf = "";
      let content = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const raw = line.slice(5).trim();
          try {
            const evt = JSON.parse(raw) as {
              delta?: string;
              done?: boolean;
              error?: string;
              reply?: string;
            };
            if (evt.error) throw new Error(evt.error);
            if (evt.delta) {
              content += evt.delta;
              setMessages([...next, { role: "assistant", content }]);
            }
            if (evt.reply && !content) {
              content = evt.reply;
              setMessages([...next, { role: "assistant", content }]);
            }
          } catch {
            /* ignore partial */
          }
        }
      }
      if (!content) {
        setMessages([
          ...next,
          {
            role: "assistant",
            content:
              lang === "zh"
                ? "（未收到回复。请在「AI 设置」中配置服务端代理。）"
                : "(No reply. Configure the server proxy in AI Settings.)",
          },
        ]);
      }
    } catch (e: any) {
      setError(String(e?.message || e));
      setMessages([
        ...next,
        {
          role: "assistant",
          content: lang === "zh" ? `出错了：${e?.message || e}` : `Error: ${e?.message || e}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function onSend(e: FormEvent) {
    e.preventDefault();
    await sendText(input);
  }

  async function quickAdd(e: FormEvent) {
    e.preventDefault();
    if (!quickUrl.trim()) return;
    await api.post("/bookmarks", { url: quickUrl.trim(), visibility: "private" });
    setQuickUrl("");
    await sendText(
      lang === "zh"
        ? `我刚添加了 ${quickUrl}，请帮我写标题、描述并推荐文件夹与标签。`
        : `I just added ${quickUrl}. Suggest title, description, folder and tags.`,
    );
  }

  const tools = lang === "zh" ? TOOLS_ZH : TOOLS_EN;

  return (
    <div className="ai-layout">
      <div className="ai-main">
        <div className="ai-header">
          <h2 className="page-title" style={{ margin: 0, fontSize: 17 }}>
            {t("ai")}
          </h2>
          <span className="badge badge-ok">● {t("aiOnline")}</span>
        </div>
        <div className="ai-messages">
          {messages.map((m, i) => (
            <div
              key={i}
              className="row"
              style={{
                gap: 10,
                flexWrap: "nowrap",
                flexDirection: m.role === "user" ? "row-reverse" : "row",
                alignItems: "flex-start",
              }}
            >
              {m.role === "assistant" ? (
                <div
                  className="letter-avatar"
                  style={{ background: "var(--accent)", width: 30, height: 30, fontSize: 13 }}
                >
                  A
                </div>
              ) : (
                <div
                  className="letter-avatar"
                  style={{ background: "var(--panel2)", color: "var(--text2)", width: 30, height: 30, fontSize: 13 }}
                >
                  U
                </div>
              )}
              <div className={`msg-bubble ${m.role === "user" ? "user" : "assistant"}`}>
                {m.content || (loading && i === messages.length - 1 ? "…" : "")}
              </div>
            </div>
          ))}
          {loading && messages[messages.length - 1]?.content === "" ? (
            <div className="row" style={{ gap: 10 }}>
              <div
                className="letter-avatar"
                style={{ background: "var(--accent)", width: 30, height: 30, fontSize: 13 }}
              >
                A
              </div>
              <div className="typing-dots">
                <span />
                <span />
                <span />
              </div>
            </div>
          ) : null}
          {error ? <div className="error">{error}</div> : null}
          <div ref={bottomRef} />
        </div>
        <form className="ai-composer" onSubmit={(e) => void onSend(e)}>
          <input
            className="input"
            style={{ flex: 1 }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("chatPh")}
            disabled={loading}
          />
          <button className="btn btn-primary" type="submit" disabled={loading || !input.trim()} style={{ padding: "0 22px" }}>
            {t("send")}
          </button>
        </form>
      </div>
      <aside className="ai-side">
        <div className="section-label" style={{ marginBottom: 12 }}>
          {t("quickTools")}
        </div>
        <div className="stack" style={{ gap: 8 }}>
          {tools.map((tl) => (
            <button
              key={tl.name}
              type="button"
              className="card"
              style={{
                padding: "12px 13px",
                cursor: "pointer",
                textAlign: "left",
                border: "1px solid var(--border)",
                background: "var(--panel)",
              }}
              onClick={() => void sendText(tl.prompt)}
            >
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>{tl.name}</div>
              <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 3, lineHeight: 1.5 }}>
                {tl.desc}
              </div>
            </button>
          ))}
        </div>
        <form className="stack" style={{ marginTop: 20, gap: 8 }} onSubmit={(e) => void quickAdd(e)}>
          <div className="section-label">{t("quickAdd")}</div>
          <input
            className="input input-mono"
            placeholder={t("quickAddUrl")}
            value={quickUrl}
            onChange={(e) => setQuickUrl(e.target.value)}
          />
          <button type="submit" className="btn btn-soft btn-sm">
            {t("quickAdd")}
          </button>
        </form>
        <div className="row" style={{ marginTop: 24, gap: 8, opacity: 0.5 }}>
          <LogoMark size={20} />
          <span className="muted-sm">MarkHub AI</span>
        </div>
      </aside>
    </div>
  );
}
