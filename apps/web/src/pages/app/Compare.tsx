import { FormEvent, useEffect, useMemo, useState } from "react";
import { BUILTIN_ENGINES, buildSearchUrl, type SearchEngine } from "@markhub/core";
import { useI18n } from "../../i18n";
import { useAuth } from "../../lib/auth";
import { PageHeader, SearchField, Chip } from "../../components/ui";

type CustomEngine = { id: string; name: string; template: string };

const ENGINE_COLORS: Record<string, string> = {
  google: "#4285f4",
  bing: "#008373",
  duckduckgo: "#de5833",
  github: "#24292f",
  mdn: "#0b5fff",
};

export function ComparePage() {
  const { t, lang } = useI18n();
  const { api } = useAuth();
  const [q, setQ] = useState("react server components");
  const [active, setActive] = useState<string[]>(["google", "bing", "duckduckgo", "github"]);
  const [custom, setCustom] = useState<CustomEngine[]>([]);
  const [newName, setNewName] = useState("");
  const [newTemplate, setNewTemplate] = useState("https://example.com/search?q=%s");
  const [searched, setSearched] = useState("");

  useEffect(() => {
    void api.get<Record<string, unknown>>("/settings").then((s) => {
      const engines = s.compare_engines;
      if (Array.isArray(engines)) {
        setCustom(
          engines
            .filter((e): e is CustomEngine => !!e && typeof e === "object")
            .map((e: any, i: number) => ({
              id: String(e.id || `custom-${i}`),
              name: String(e.name || e.nameZh || `Engine ${i + 1}`),
              template: String(e.template || ""),
            }))
            .filter((e) => e.template.includes("%s") || e.template.includes("{q}")),
        );
      }
      if (Array.isArray(s.compare_active_ids)) {
        setActive(s.compare_active_ids.map(String));
      }
    });
  }, [api]);

  const allEngines: SearchEngine[] = useMemo(() => {
    const customs: SearchEngine[] = custom.map((c) => ({
      id: c.id,
      name: c.name,
      nameZh: c.name,
      template: c.template,
      noIframe: true,
    }));
    return [...BUILTIN_ENGINES, ...customs];
  }, [custom]);

  const engines = useMemo(
    () => allEngines.filter((e) => active.includes(e.id)),
    [active, allEngines],
  );

  async function persist(nextCustom: CustomEngine[], nextActive: string[]) {
    await api.put("/settings", {
      compare_engines: nextCustom,
      compare_active_ids: nextActive,
    });
  }

  function toggleEngine(id: string) {
    const next = active.includes(id) ? active.filter((x) => x !== id) : [...active, id];
    setActive(next);
    void persist(custom, next);
  }

  function doSearch() {
    if (!q.trim()) return;
    setSearched(q.trim());
  }

  function openAll() {
    if (!q.trim()) return;
    for (const e of engines) {
      window.open(buildSearchUrl(e.template, q), "_blank", "noopener,noreferrer");
    }
  }

  async function addCustom(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !newTemplate.trim()) return;
    if (!newTemplate.includes("%s") && !newTemplate.includes("{q}")) return;
    const eng: CustomEngine = {
      id: `custom-${Date.now()}`,
      name: newName.trim(),
      template: newTemplate.trim(),
    };
    const next = [...custom, eng];
    const nextActive = [...active, eng.id];
    setCustom(next);
    setActive(nextActive);
    setNewName("");
    await persist(next, nextActive);
  }

  async function removeCustom(id: string) {
    const next = custom.filter((c) => c.id !== id);
    const nextActive = active.filter((x) => x !== id);
    setCustom(next);
    setActive(nextActive);
    await persist(next, nextActive);
  }

  return (
    <div>
      <PageHeader title={t("compare")} sub={t("compareSub")} />

      <div className="row" style={{ gap: 10, marginBottom: 14, maxWidth: 640 }}>
        <SearchField
          value={q}
          onChange={setQ}
          placeholder={t("cmpPh")}
          style={{ flex: 1 }}
        />
        <button type="button" className="btn btn-primary" onClick={doSearch}>
          {t("searchBtn")}
        </button>
        <button type="button" className="btn btn-soft" onClick={openAll} disabled={!q.trim()}>
          {t("searchAll")}
        </button>
      </div>

      <div className="row" style={{ gap: 8, marginBottom: 18 }}>
        {allEngines.map((e) => (
          <Chip key={e.id} active={active.includes(e.id)} onClick={() => toggleEngine(e.id)}>
            {lang === "zh" && e.nameZh ? e.nameZh : e.name}
          </Chip>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: 14,
          marginBottom: 24,
        }}
      >
        {engines.map((e) => {
          const query = searched || q;
          const url = query ? buildSearchUrl(e.template, query) : "";
          const color = ENGINE_COLORS[e.id] || "var(--accent)";
          return (
            <div key={e.id} className="card card-flush">
              <div className="row" style={{ gap: 9, padding: "11px 14px", borderBottom: "1px solid var(--border)" }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: color }} />
                <span style={{ fontWeight: 600, fontSize: 13 }}>
                  {lang === "zh" && e.nameZh ? e.nameZh : e.name}
                </span>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer" className="spacer" style={{ fontSize: 11.5 }}>
                    {t("openNew")} ↗
                  </a>
                ) : null}
              </div>
              <div
                style={{
                  height: 200,
                  background:
                    "repeating-linear-gradient(45deg,var(--panel2),var(--panel2) 8px,var(--panel) 8px,var(--panel) 16px)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <span
                  className="mono"
                  style={{
                    background: "var(--panel)",
                    padding: "5px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                  }}
                >
                  {query ? `iframe: ${query}` : t("enterQuery")}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="card stack" style={{ maxWidth: 560 }}>
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t("customEngines")}</div>
        <form className="row" onSubmit={(e) => void addCustom(e)}>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder={t("engineName")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            className="input input-mono"
            style={{ flex: 2 }}
            placeholder={t("engineTemplate")}
            value={newTemplate}
            onChange={(e) => setNewTemplate(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm">
            {t("addEngine")}
          </button>
        </form>
        {custom.map((c) => (
          <div key={c.id} className="row">
            <span style={{ fontWeight: 500, fontSize: 13 }}>{c.name}</span>
            <span className="mono grow">{c.template}</span>
            <button type="button" className="btn btn-sm" onClick={() => void removeCustom(c.id)}>
              {t("remove")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
