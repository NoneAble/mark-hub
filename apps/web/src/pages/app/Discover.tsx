import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { useAuth } from "../../lib/auth";

type WidgetDef = { id: string; name: string; enabled: boolean };
type WidgetItem = { title: string; url: string; meta?: string };

const DEFAULT_WIDGETS: WidgetDef[] = [
  { id: "github_trending", name: "GitHub Trending", enabled: true },
  { id: "newsnow", name: "NewsNow", enabled: false },
  { id: "info_entries", name: "Info entries", enabled: true },
];

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

  function label(w: WidgetDef) {
    if (w.id === "github_trending") return t("githubTrending");
    if (w.id === "newsnow") return t("newsNow");
    if (w.id === "info_entries") return t("infoEntries");
    return w.name;
  }

  return (
    <div className="stack">
      <h1 className="page-title">{t("discover")}</h1>
      <p className="muted">{t("discoverHint")}</p>
      {loading ? <div className="muted">{t("loading")}</div> : null}
      <div className="grid-cards">
        {widgets.map((w) => (
          <div key={w.id} className="card stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{label(w)}</strong>
              <button className="btn" type="button" onClick={() => void toggle(w.id)}>
                {w.enabled ? t("widgetOn") : t("widgetOff")}
              </button>
            </div>
            {w.enabled ? (
              <WidgetBody items={data[w.id] || []} />
            ) : (
              <div className="muted">{t("widgetDisabled")}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function WidgetBody({ items }: { items: WidgetItem[] }) {
  const { t } = useI18n();
  if (!items.length) return <div className="muted">{t("noItems")}</div>;
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {items.map((it, i) => (
        <li key={i} style={{ marginBottom: 6 }}>
          <a href={it.url} target="_blank" rel="noreferrer">
            {it.title}
          </a>
          {it.meta ? (
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
              {it.meta}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
