import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { useAuth } from "../../lib/auth";
import { PageHeader } from "../../components/ui";

type WidgetDef = { id: string; name: string; enabled: boolean };
type WidgetItem = { title: string; url: string; meta?: string; stars?: string; source?: string };

const DEFAULT_WIDGETS: WidgetDef[] = [
  { id: "github_trending", name: "GitHub Trending", enabled: true },
  { id: "newsnow", name: "NewsNow", enabled: true },
  { id: "info_entries", name: "Info entries", enabled: false },
];

const FALLBACK_TRENDING = [
  { title: "cloudflare/workers-sdk", url: "https://github.com/cloudflare/workers-sdk", meta: "12.4k", desc: "Cloudflare Workers CLI & tooling" },
  { title: "vitejs/vite", url: "https://github.com/vitejs/vite", meta: "68k", desc: "Next generation frontend tooling" },
  { title: "shadcn/ui", url: "https://github.com/shadcn-ui/ui", meta: "78k", desc: "Beautifully designed components" },
  { title: "openai/openai-python", url: "https://github.com/openai/openai-python", meta: "24k", desc: "Official Python library for OpenAI API" },
];

const FALLBACK_NEWS = [
  { title: "Show HN: I built a self-hosted bookmark manager", url: "#", source: "HN", time: "12m" },
  { title: "书签管理的终极方案讨论", url: "#", source: "V2EX", time: "38m" },
  { title: "D1 read replication now GA", url: "#", source: "GH", time: "1h" },
  { title: "The case for local-first software (2026)", url: "#", source: "HN", time: "2h" },
  { title: "我的数字花园工作流", url: "#", source: "少数派", time: "3h" },
];

const SRC_STYLE: Record<string, { fg: string; bg: string }> = {
  HN: { fg: "#f60", bg: "rgba(255,102,0,.1)" },
  V2EX: { fg: "#334", bg: "rgba(51,68,85,.1)" },
  GH: { fg: "#24292f", bg: "rgba(36,41,47,.08)" },
  少数派: { fg: "#d71a1b", bg: "rgba(215,26,27,.08)" },
};

export function DiscoverPage() {
  const { t } = useI18n();
  const { api } = useAuth();
  const [widgets, setWidgets] = useState(DEFAULT_WIDGETS);
  const [data, setData] = useState<Record<string, WidgetItem[]>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void api.get<any>("/settings").then((s) => {
      if (Array.isArray(s.discover_widgets) && s.discover_widgets.length) {
        setWidgets(s.discover_widgets);
      }
    });
  }, [api]);

  useEffect(() => {
    const enabled = widgets.filter((w) => w.enabled).map((w) => w.id);
    if (!enabled.length) return;
    setLoading(true);
    void api
      .get<{ widgets: Record<string, WidgetItem[]> }>(
        `/discover/widgets?ids=${encodeURIComponent(enabled.join(","))}`,
      )
      .then((r) => setData(r.widgets || {}))
      .catch(() => setData({}))
      .finally(() => setLoading(false));
  }, [api, widgets]);

  async function toggle(id: string) {
    const next = widgets.map((w) => (w.id === id ? { ...w, enabled: !w.enabled } : w));
    setWidgets(next);
    await api.put("/settings", { discover_widgets: next });
  }

  function itemsFor(id: string): WidgetItem[] {
    const remote = data[id];
    if (remote?.length) return remote;
    if (id === "github_trending") {
      return FALLBACK_TRENDING.map((r) => ({
        title: r.title,
        url: r.url,
        meta: r.meta,
        desc: r.desc,
      })) as WidgetItem[];
    }
    if (id === "newsnow") {
      return FALLBACK_NEWS.map((r) => ({
        title: r.title,
        url: r.url,
        meta: r.time,
        source: r.source,
      }));
    }
    return [];
  }

  const trend = widgets.find((w) => w.id === "github_trending");
  const news = widgets.find((w) => w.id === "newsnow");
  const others = widgets.filter((w) => w.id !== "github_trending" && w.id !== "newsnow");

  return (
    <div style={{ maxWidth: 1020 }}>
      <PageHeader title={t("discover")} sub={t("discoverHint")} />
      {loading ? <div className="muted" style={{ marginBottom: 12 }}>{t("loading")}</div> : null}

      <div className="discover-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {trend ? (
          <WidgetPanel
            title="GitHub Trending"
            subtitle="daily"
            enabled={trend.enabled}
            onToggle={() => void toggle(trend.id)}
            onLabel={t("widgetOn")}
            offLabel={t("widgetOff")}
          >
            {trend.enabled ? (
              <TrendingList items={itemsFor("github_trending")} empty={t("noItems")} />
            ) : (
              <div className="muted" style={{ padding: 16 }}>{t("widgetDisabled")}</div>
            )}
          </WidgetPanel>
        ) : null}

        {news ? (
          <WidgetPanel
            title="NewsNow"
            subtitle="realtime"
            enabled={news.enabled}
            onToggle={() => void toggle(news.id)}
            onLabel={t("widgetOn")}
            offLabel={t("widgetOff")}
          >
            {news.enabled ? (
              <NewsList items={itemsFor("newsnow")} empty={t("noItems")} />
            ) : (
              <div className="muted" style={{ padding: 16 }}>{t("widgetDisabled")}</div>
            )}
          </WidgetPanel>
        ) : null}

        {others.map((w) => (
          <WidgetPanel
            key={w.id}
            title={w.id === "info_entries" ? t("infoEntries") : w.name}
            subtitle={w.id}
            enabled={w.enabled}
            onToggle={() => void toggle(w.id)}
            onLabel={t("widgetOn")}
            offLabel={t("widgetOff")}
          >
            {w.enabled ? (
              <TrendingList items={itemsFor(w.id)} empty={t("noItems")} />
            ) : (
              <div className="muted" style={{ padding: 16 }}>{t("widgetDisabled")}</div>
            )}
          </WidgetPanel>
        ))}
      </div>
    </div>
  );
}

function WidgetPanel({
  title,
  subtitle,
  enabled,
  onToggle,
  onLabel,
  offLabel,
  children,
}: {
  title: string;
  subtitle: string;
  enabled: boolean;
  onToggle: () => void;
  onLabel: string;
  offLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="card card-flush">
      <div className="row" style={{ gap: 9, padding: "13px 16px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>{title}</span>
        <span className="mono">{subtitle}</span>
        <button type="button" className="btn btn-sm spacer" onClick={onToggle}>
          {enabled ? onLabel : offLabel}
        </button>
      </div>
      {children}
    </div>
  );
}

function TrendingList({ items, empty }: { items: WidgetItem[]; empty: string }) {
  if (!items.length) return <div className="muted" style={{ padding: 16 }}>{empty}</div>;
  return (
    <div>
      {items.map((r, i) => (
        <a key={i} className="list-row" href={r.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
          <span className="mono" style={{ width: 18, flex: "none" }}>
            {i + 1}
          </span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: 12.5, color: "var(--accent-text)" }}>{r.title}</div>
            {(r as any).desc || r.meta ? (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text3)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {(r as any).desc || r.meta}
              </div>
            ) : null}
          </div>
          {r.meta && (r as any).desc ? (
            <span style={{ fontSize: 11, color: "var(--text3)", flex: "none" }}>★ {r.meta}</span>
          ) : null}
        </a>
      ))}
    </div>
  );
}

function NewsList({ items, empty }: { items: WidgetItem[]; empty: string }) {
  if (!items.length) return <div className="muted" style={{ padding: 16 }}>{empty}</div>;
  return (
    <div>
      {items.map((r, i) => {
        const src = (r as any).source || "NEWS";
        const st = SRC_STYLE[src] || { fg: "var(--text2)", bg: "var(--panel2)" };
        return (
          <a key={i} className="list-row" href={r.url || "#"} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
            <span
              style={{
                fontSize: 10.5,
                color: st.fg,
                background: st.bg,
                borderRadius: 5,
                padding: "2px 7px",
                flex: "none",
              }}
            >
              {src}
            </span>
            <div
              style={{
                fontSize: 12.5,
                minWidth: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
              }}
            >
              {r.title}
            </div>
            <span className="mono spacer" style={{ flex: "none" }}>
              {r.meta}
            </span>
          </a>
        );
      })}
    </div>
  );
}
