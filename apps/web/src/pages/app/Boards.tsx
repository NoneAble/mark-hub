import { FormEvent, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";
import { ANNOTATION_STATUSES, STATUS_LABELS, type AnnotationStatus } from "@markhub/core";
import { brandOf } from "../../lib/colors";
import { STATUS_COLORS } from "../../lib/colors";
import { Chip, LetterAvatar, PageHeader } from "../../components/ui";

export function BoardsPage() {
  const { api } = useAuth();
  const { t, lang } = useI18n();
  const [boards, setBoards] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [bookmarks, setBookmarks] = useState<Record<string, any>>({});
  const [name, setName] = useState("AI Channels");
  const [folders, setFolders] = useState<any[]>([]);
  const [source, setSource] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [editName, setEditName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupKeywords, setGroupKeywords] = useState("");
  const [importJson, setImportJson] = useState("");
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [batchStatus, setBatchStatus] = useState("active");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [scanning, setScanning] = useState(false);
  const [showManage, setShowManage] = useState(false);

  async function loadBoards() {
    const r = await api.get<{ items: any[] }>("/boards");
    setBoards(r.items);
    if (!selected && r.items[0]) setSelected(r.items[0].id);
  }

  async function loadBoardDetail(boardId: string) {
    const [anns, grps, board, home] = await Promise.all([
      api.get<{ items: any[] }>(`/boards/${boardId}/annotations`),
      api.get<{ items: any[] }>(`/boards/${boardId}/groups`).catch(() => ({ items: [] })),
      api.get<any>(`/boards/${boardId}`).catch(() => null),
      api.get<{ bookmarks: any[] }>("/nav/home").catch(() => ({ bookmarks: [] })),
    ]);
    setAnnotations(anns.items || []);
    setGroups(grps.items || []);
    const bmMap: Record<string, any> = {};
    for (const b of home.bookmarks || []) bmMap[b.id] = b;
    setBookmarks(bmMap);
    if (board) {
      setEditName(board.name || "");
      setSource(board.source_folder_ids || []);
    }
  }

  useEffect(() => {
    void loadBoards();
    void api.get<{ items: any[] }>("/folders").then((r) => setFolders(r.items));
  }, [api]);

  useEffect(() => {
    if (!selected) return;
    void loadBoardDetail(selected);
  }, [selected, api]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setErr("");
    const b = await api.post<any>("/boards", {
      name,
      type: "ai_channels",
      source_folder_ids: source,
    });
    await loadBoards();
    setSelected(b.id);
    setMsg(`Created board ${b.name}`);
  }

  async function saveBoard() {
    if (!selected) return;
    setErr("");
    await api.patch(`/boards/${selected}`, {
      name: editName,
      source_folder_ids: source,
    });
    await loadBoards();
    setMsg("Board updated");
    await loadBoardDetail(selected);
  }

  async function deleteBoard() {
    if (!selected) return;
    if (!window.confirm("Delete this board and all annotations?")) return;
    await api.delete(`/boards/${selected}`);
    setSelected(null);
    setAnnotations([]);
    setGroups([]);
    await loadBoards();
    setMsg("Board deleted");
  }

  async function scan(mode: "full" | "incremental") {
    if (!selected) return;
    setErr("");
    setScanning(true);
    try {
      const r = await api.post<any>(`/boards/${selected}/scan`, { mode });
      setMsg(`Scan ${r.mode}: created=${r.created ?? 0} updated=${r.updated ?? 0}`);
      await loadBoardDetail(selected);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setScanning(false);
    }
  }

  async function cycleStatus(a: any) {
    const order = ANNOTATION_STATUSES;
    const idx = order.indexOf(a.status as AnnotationStatus);
    const next = order[(idx + 1) % order.length];
    await patchAnnotation(a.id, { status: next });
  }

  async function patchAnnotation(aid: string, patch: Record<string, unknown>) {
    if (!selected) return;
    await api.patch(`/boards/${selected}/annotations/${aid}`, patch);
    setAnnotations((await api.get<{ items: any[] }>(`/boards/${selected}/annotations`)).items);
  }

  async function createGroup(e: FormEvent) {
    e.preventDefault();
    if (!selected || !groupName.trim()) return;
    await api.post(`/boards/${selected}/groups`, {
      name: groupName.trim(),
      keywords: groupKeywords
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setGroupName("");
    setGroupKeywords("");
    await loadBoardDetail(selected);
    setMsg("Group created");
  }

  async function reorderGroups() {
    if (!selected || !groups.length) return;
    const ordered = [...groups].map((g) => g.id).reverse();
    await api.post(`/boards/${selected}/groups/reorder`, { ordered_ids: ordered });
    await loadBoardDetail(selected);
    setMsg("Groups reordered");
  }

  async function exportBoard(format: "json" | "html") {
    if (!selected) return;
    if (format === "html") {
      const res = await fetch(`/api/v1/boards/${selected}/export`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("markhub_token")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ format: "html" }),
      });
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "board.html";
      a.click();
      URL.revokeObjectURL(a.href);
      setMsg("HTML exported");
      return;
    }
    const r = await api.post<any>(`/boards/${selected}/export`, { format: "json" });
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "board.json";
    a.click();
    URL.revokeObjectURL(a.href);
    setMsg("JSON exported");
  }

  async function importBoard() {
    if (!selected || !importJson.trim()) return;
    setErr("");
    try {
      const data = JSON.parse(importJson);
      const r = await api.post<any>(`/boards/${selected}/import`, { data, merge: true });
      setMsg(`Import: ${JSON.stringify(r)}`);
      await loadBoardDetail(selected);
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  }

  async function batchUpdate() {
    if (!selected || !batchSelected.size) return;
    const items = [...batchSelected].map((id) => ({ id, status: batchStatus }));
    try {
      await api.post(`/boards/${selected}/annotations/batch`, { items });
    } catch {
      for (const id of batchSelected) {
        await api.patch(`/boards/${selected}/annotations/${id}`, { status: batchStatus });
      }
    }
    setBatchSelected(new Set());
    await loadBoardDetail(selected);
    setMsg(`Batch updated ${items.length} annotations`);
  }

  function toggleBatch(id: string) {
    setBatchSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const board = boards.find((b) => b.id === selected);
  const statusCounts = useMemo(() => {
    const m: Record<string, number> = { all: annotations.length };
    for (const s of ANNOTATION_STATUSES) m[s] = 0;
    for (const a of annotations) {
      m[a.status] = (m[a.status] || 0) + 1;
    }
    return m;
  }, [annotations]);

  const shown = useMemo(() => {
    if (statusFilter === "all") return annotations;
    return annotations.filter((a) => a.status === statusFilter);
  }, [annotations, statusFilter]);

  const groupNameOf = (gid: string | null) => groups.find((g) => g.id === gid)?.name || "";

  return (
    <div>
      <PageHeader
        title={
          <span className="row" style={{ gap: 10 }}>
            <span>{board?.name || t("boards")}</span>
            {board ? (
              <span className="badge badge-accent">{board.type || "ai_channels"}</span>
            ) : null}
          </span>
        }
        sub={t("boardSub")}
        actions={
          selected ? (
            <div className="row">
              <button
                className="btn btn-soft btn-sm"
                type="button"
                data-testid="scan-inc"
                disabled={scanning}
                onClick={() => void scan("incremental")}
              >
                {scanning ? "…" : t("scanIncremental")}
              </button>
              <button
                className="btn btn-primary btn-sm"
                type="button"
                data-testid="scan-full"
                disabled={scanning}
                onClick={() => void scan("full")}
              >
                {t("scanFull")}
              </button>
              <button className="btn btn-sm" type="button" onClick={() => setShowManage((v) => !v)}>
                {showManage ? t("done") : "⚙"}
              </button>
            </div>
          ) : null
        }
      />

      {msg ? <div className="success" style={{ marginBottom: 12 }}>{msg}</div> : null}
      {err ? <div className="error" style={{ marginBottom: 12 }}>{err}</div> : null}

      <div className="row wrap" style={{ marginBottom: 16 }}>
        {boards.map((b) => (
          <button
            key={b.id}
            type="button"
            className={`chip${selected === b.id ? " active" : ""}`}
            onClick={() => setSelected(b.id)}
            data-testid={`board-tab-${b.id}`}
          >
            {b.name}
          </button>
        ))}
      </div>

      {selected ? (
        <>
          <div className="row wrap" style={{ marginBottom: 18, gap: 8 }}>
            <Chip active={statusFilter === "all"} onClick={() => setStatusFilter("all")} count={statusCounts.all}>
              {lang === "zh" ? "全部" : "All"}
            </Chip>
            {ANNOTATION_STATUSES.map((s) => (
              <Chip
                key={s}
                active={statusFilter === s}
                onClick={() => setStatusFilter(s)}
                count={statusCounts[s] || 0}
              >
                {STATUS_LABELS[s][lang === "zh" ? "zh" : "en"]}
              </Chip>
            ))}
          </div>

          <div
            className="grid-cards"
            style={{ marginBottom: 24 }}
            data-testid="annotations-table"
          >
            {shown.map((a) => {
              const bm = bookmarks[a.bookmark_id];
              const title = bm?.title || a.source_ref || String(a.bookmark_id || "").slice(0, 8);
              const url = bm?.url || "";
              const b = brandOf(url || title);
              const colors = STATUS_COLORS[a.status] || STATUS_COLORS.pending;
              const gname = groupNameOf(a.group_id) || a.category || "";
              return (
                <div
                  key={a.id}
                  className="bm-card"
                  style={{ opacity: a.present === false ? 0.55 : 1, gap: 9 }}
                >
                  <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
                    <input
                      type="checkbox"
                      checked={batchSelected.has(a.id)}
                      onChange={() => toggleBatch(a.id)}
                      style={{ flex: "none" }}
                    />
                    <LetterAvatar url={url} title={title} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div>
                      <div className="bm-domain">{b.domain || a.source_folder_path || ""}</div>
                    </div>
                    <button
                      type="button"
                      className="status-pill"
                      style={{ color: colors[0], background: colors[1] }}
                      title="Click to cycle status"
                      onClick={() => void cycleStatus(a)}
                    >
                      {STATUS_LABELS[a.status as AnnotationStatus]?.[lang === "zh" ? "zh" : "en"] ||
                        a.status}
                    </button>
                  </div>
                  <div className="row" style={{ gap: 6, fontSize: 10.5 }}>
                    {a.risk ? (
                      <span className="badge">
                        {t("risk")} {a.risk}
                      </span>
                    ) : null}
                    {a.price_tag ? (
                      <span className="badge">
                        {t("price")} {a.price_tag}
                      </span>
                    ) : null}
                    {gname ? <span className="badge badge-accent">{gname}</span> : null}
                  </div>
                  <div className="bm-desc" style={{ minHeight: 17 }}>
                    {a.note || ""}
                  </div>
                  <div className="mono">
                    {a.present === false && a.missing_since
                      ? `missing_since ${String(a.missing_since).slice(0, 16)}`
                      : a.last_seen_at
                        ? `last_seen ${String(a.last_seen_at).slice(0, 16)}`
                        : ""}
                  </div>
                </div>
              );
            })}
          </div>

          {showManage ? (
            <div className="stack" style={{ gap: 16 }}>
              <div className="card stack">
                <h3 style={{ margin: 0, fontSize: 14 }}>{lang === "zh" ? "看板设置" : "Board settings"}</h3>
                <input
                  className="input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  data-testid="board-edit-name"
                />
                <select
                  className="input"
                  multiple
                  style={{ minHeight: 80 }}
                  value={source}
                  onChange={(e) => setSource(Array.from(e.target.selectedOptions).map((o) => o.value))}
                >
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <div className="row wrap">
                  <button className="btn btn-primary" type="button" onClick={() => void saveBoard()}>
                    {t("save")}
                  </button>
                  <button className="btn" type="button" data-testid="board-delete" onClick={() => void deleteBoard()}>
                    {t("delete")}
                  </button>
                  <button className="btn" type="button" data-testid="export-json" onClick={() => void exportBoard("json")}>
                    {t("export")} JSON
                  </button>
                  <button className="btn" type="button" data-testid="export-html" onClick={() => void exportBoard("html")}>
                    {t("export")} HTML
                  </button>
                </div>
              </div>

              <div className="card stack">
                <h3 style={{ margin: 0, fontSize: 14 }}>Groups</h3>
                <form className="row wrap" onSubmit={createGroup}>
                  <input
                    className="input"
                    placeholder="Group name"
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    data-testid="group-name"
                  />
                  <input
                    className="input"
                    placeholder="keywords,comma,separated"
                    value={groupKeywords}
                    onChange={(e) => setGroupKeywords(e.target.value)}
                  />
                  <button className="btn btn-primary" type="submit" data-testid="group-create">
                    Add group
                  </button>
                  <button className="btn" type="button" onClick={() => void reorderGroups()}>
                    Reverse order
                  </button>
                </form>
                <ul>
                  {groups.map((g) => (
                    <li key={g.id}>
                      {g.name} <span className="muted">{Array.isArray(g.keywords) ? g.keywords.join(", ") : g.keywords}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="card stack">
                <h3 style={{ margin: 0, fontSize: 14 }}>Import pack</h3>
                <textarea
                  className="input"
                  rows={4}
                  placeholder='{"groups":[...],"annotations":[...]}'
                  value={importJson}
                  onChange={(e) => setImportJson(e.target.value)}
                  data-testid="board-import-json"
                />
                <button className="btn" type="button" data-testid="board-import" onClick={() => void importBoard()}>
                  {t("import")}
                </button>
              </div>

              <div className="card stack">
                <h3 style={{ margin: 0, fontSize: 14 }}>Batch</h3>
                <div className="row">
                  <select className="input" value={batchStatus} onChange={(e) => setBatchStatus(e.target.value)}>
                    {(Object.keys(STATUS_LABELS) as AnnotationStatus[]).map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABELS[s][lang === "zh" ? "zh" : "en"]}
                      </option>
                    ))}
                  </select>
                  <button className="btn" type="button" data-testid="batch-ann" onClick={() => void batchUpdate()}>
                    Apply to selected ({batchSelected.size})
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      <form className="card row wrap" onSubmit={create} data-testid="board-create-form" style={{ marginTop: 20 }}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Board name" style={{ maxWidth: 200 }} />
        <select
          className="input"
          multiple
          style={{ minHeight: 64, maxWidth: 260 }}
          value={source}
          onChange={(e) => setSource(Array.from(e.target.selectedOptions).map((o) => o.value))}
          data-testid="board-source-folders"
        >
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" type="submit">
          {t("createBoard")}
        </button>
      </form>
    </div>
  );
}
