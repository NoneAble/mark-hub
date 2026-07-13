import { FormEvent, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";

type Msg = { role: "user" | "assistant"; content: string };

export function AIChatPage() {
  const { api, token } = useAuth();
  const { t } = useI18n();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [quickUrl, setQuickUrl] = useState("");

  async function onSend(e: FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    const next = [...messages, { role: "user" as const, content: input.trim() }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError("");
    // Streaming assistant placeholder
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
        // Fallback to JSON non-stream
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
          const line = part
            .split("\n")
            .find((l) => l.startsWith("data:"));
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
            if (evt.reply) {
              content = evt.reply;
              setMessages([...next, { role: "assistant", content }]);
            }
          } catch (err) {
            if (err instanceof SyntaxError) continue;
            throw err;
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("failed"));
    } finally {
      setLoading(false);
    }
  }

  async function quickAdd() {
    if (!quickUrl) return;
    await api.post("/ai/quick-add", { url: quickUrl });
    setQuickUrl("");
    setError("");
    setMessages((m) => [
      ...m,
      { role: "assistant", content: `${t("quickAdd")}: ${quickUrl}` },
    ]);
  }

  return (
    <div className="stack" style={{ maxWidth: 800 }}>
      <h1 className="page-title">{t("ai")}</h1>
      <div className="card row">
        <input
          className="input"
          placeholder={t("quickAddUrl")}
          value={quickUrl}
          onChange={(e) => setQuickUrl(e.target.value)}
        />
        <button className="btn" type="button" onClick={() => void quickAdd()}>
          {t("quickAdd")}
        </button>
      </div>
      <div className="card stack" style={{ minHeight: 320 }}>
        {messages.length === 0 ? (
          <div className="muted">{t("aiChatHint")}</div>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                background: m.role === "user" ? "var(--accent-weak)" : "var(--panel2)",
                padding: "10px 12px",
                borderRadius: 10,
                maxWidth: "90%",
                whiteSpace: "pre-wrap",
              }}
            >
              {m.content}
            </div>
          ))
        )}
      </div>
      {error ? <div className="error">{error}</div> : null}
      <form className="row" onSubmit={onSend}>
        <input
          className="input"
          style={{ flex: 1 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("search")}
          disabled={loading}
        />
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? t("loading") : t("send")}
        </button>
      </form>
    </div>
  );
}
