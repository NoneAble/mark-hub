import { FormEvent, useEffect, useMemo, useState } from "react";
import { BUILTIN_ENGINES, buildSearchUrl, type SearchEngine } from "@markhub/core";
import { useI18n } from "../../i18n";
import { useAuth } from "../../lib/auth";

type CustomEngine = { id: string; name: string; template: string };

export function ComparePage() {
  const { t, lang } = useI18n();
  const { api } = useAuth();
  const [q, setQ] = useState("");
  const [active, setActive] = useState<string[]>(["google", "bing", "duckduckgo"]);
  const [custom, setCustom] = useState<CustomEngine[]>([]);
  const [newName, setNewName] = useState("");
  const [newTemplate, setNewTemplate] = useState("https://example.com/search?q=%s");

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

  async function toggle(id: string, checked: boolean) {
    const next = checked ? [...active, id] : active.filter((x) => x !== id);
    setActive(next);
    await persist(custom, next);
  }

  return (
    <div className="stack">
      <h1 className="page-title">{t("compare")}</h1>
      <div className="card row">
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder={t("search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && openAll()}
        />
        <button className="btn btn-primary" type="button" onClick={openAll}>
          {t("searchAll")}
        </button>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {allEngines.map((e) => (
          <label key={e.id} className="row" style={{ gap: 4 }}>
            <input
              type="checkbox"
              checked={active.includes(e.id)}
              onChange={(ev) => void toggle(e.id, ev.target.checked)}
            />
            {lang === "zh" ? e.nameZh : e.name}
          </label>
        ))}
      </div>

      <div className="card stack">
        <strong>{t("customEngines")}</strong>
        <form className="row" onSubmit={addCustom}>
          <input
            className="input"
            placeholder={t("engineName")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder={t("engineTemplate")}
            value={newTemplate}
            onChange={(e) => setNewTemplate(e.target.value)}
          />
          <button className="btn" type="submit">
            {t("addEngine")}
          </button>
        </form>
        {custom.map((c) => (
          <div key={c.id} className="row" style={{ justifyContent: "space-between" }}>
            <span>
              {c.name} — <code style={{ fontSize: 11 }}>{c.template}</code>
            </span>
            <button className="btn" type="button" onClick={() => void removeCustom(c.id)}>
              {t("remove")}
            </button>
          </div>
        ))}
      </div>

      <div className="grid-cards">
        {engines.map((e) => {
          const url = q ? buildSearchUrl(e.template, q) : "";
          return (
            <div key={e.id} className="card stack">
              <strong>{lang === "zh" && e.nameZh ? e.nameZh : e.name}</strong>
              {url ? (
                <a href={url} target="_blank" rel="noreferrer">
                  {t("open")}
                </a>
              ) : (
                <span className="muted">{t("enterQuery")}</span>
              )}
              <div className="muted" style={{ fontSize: 11, wordBreak: "break-all" }}>
                {e.template}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
