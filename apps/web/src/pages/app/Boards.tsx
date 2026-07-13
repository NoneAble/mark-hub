import { FormEvent, useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";
import { STATUS_LABELS, type AnnotationStatus } from "@markhub/core";

export function BoardsPage() {
  const { api } = useAuth();
  const { t, lang } = useI18n();
  const [boards, setBoards] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
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
  const [batchStatus, setBatchStatus] = useState("available");

  async function loadBoards() {
    const r = await api.get<{ items: any[] }>("/boards");
    setBoards(r.items);
    if (!selected && r.items[0]) setSelected(r.items[0].id);
  }

  async function loadBoardDetail(boardId: string) {
    const [anns, grps, board] = await Promise.all([
      api.get<{ items: any[] }>(`/boards/${boardId}/annotations`),
      api.get<{ items: any[] }>(`/boards/${boardId}/groups`).catch(() => ({ items: [] })),
      api.get<any>(`/boards/${boardId}`).catch(() => null),
    ]);
    setAnnotations(anns.items || []);
    setGroups(grps.items || []);
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
    setMsg("Board updated (sources trigger scan)");
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
    try {
      const r = await api.post<any>(`/boards/${selected}/scan`, { mode });
      setMsg(`Scan ${r.mode}: created=${r.created ?? 0} updated=${r.updated ?? 0} applied=${r.applied ?? 0}`);
      await loadBoardDetail(selected);
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
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
      // fallback sequential patch
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

  return (
    <div className="stack">
      <h1 className="page-title">{t("boards")}</h1>
      {msg ? <div className="success">{msg}</div> : null}
      {err ? <div className="error">{err}</div> : null}

      <form className="card row wrap" onSubmit={create} data-testid="board-create-form">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Board name" />
        <select
          className="input"
          multiple
          style={{ minHeight: 80 }}
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

      <div className="row wrap">
        {boards.map((b) => (
          <button
            key={b.id}
            type="button"
            className="btn"
            style={{ borderColor: selected === b.id ? "var(--accent)" : undefined }}
            onClick={() => setSelected(b.id)}
            data-testid={`board-tab-${b.id}`}
          >
            {b.name}
          </button>
        ))}
      </div>

      {selected ? (
        <>
          <div className="card stack">
            <h3>Board settings</h3>
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
                Save board
              </button>
              <button className="btn" type="button" data-testid="board-delete" onClick={() => void deleteBoard()}>
                Delete board
              </button>
              <button className="btn btn-primary" type="button" data-testid="scan-full" onClick={() => void scan("full")}>
                {t("scanFull")}
              </button>
              <button className="btn" type="button" data-testid="scan-inc" onClick={() => void scan("incremental")}>
                {t("scanIncremental")}
              </button>
              <button className="btn" type="button" data-testid="export-json" onClick={() => void exportBoard("json")}>
                Export JSON
              </button>
              <button className="btn" type="button" data-testid="export-html" onClick={() => void exportBoard("html")}>
                Export HTML
              </button>
            </div>
          </div>

          <div className="card stack">
            <h3>Groups</h3>
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
                  {g.name} <span className="muted">{g.keywords}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="card stack">
            <h3>Import pack</h3>
            <textarea
              className="input"
              rows={4}
              placeholder='{"groups":[...],"annotations":[...]}'
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
              data-testid="board-import-json"
            />
            <button className="btn" type="button" data-testid="board-import" onClick={() => void importBoard()}>
              Import
            </button>
          </div>

          <div className="card stack">
            <h3>Batch annotations</h3>
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

          <div className="card" style={{ padding: 0 }}>
            <table className="table" data-testid="annotations-table">
              <thead>
                <tr>
                  <th />
                  <th>Bookmark</th>
                  <th>Status</th>
                  <th>Risk</th>
                  <th>Price</th>
                  <th>Category</th>
                  <th>Note</th>
                  <th>Group</th>
                  <th>Path</th>
                  <th>Present</th>
                </tr>
              </thead>
              <tbody>
                {annotations.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={batchSelected.has(a.id)}
                        onChange={() => toggleBatch(a.id)}
                      />
                    </td>
                    <td className="muted">{String(a.bookmark_id || "").slice(0, 8)}</td>
                    <td>
                      <select
                        className="input"
                        style={{ width: 120 }}
                        value={a.status}
                        onChange={(e) => void patchAnnotation(a.id, { status: e.target.value })}
                      >
                        {(Object.keys(STATUS_LABELS) as AnnotationStatus[]).map((s) => (
                          <option key={s} value={s}>
                            {STATUS_LABELS[s][lang === "zh" ? "zh" : "en"]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="input"
                        style={{ width: 80 }}
                        value={a.risk || ""}
                        onChange={(e) => setAnnotations((rows) => rows.map((r) => (r.id === a.id ? { ...r, risk: e.target.value } : r)))}
                        onBlur={(e) => void patchAnnotation(a.id, { risk: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="input"
                        style={{ width: 80 }}
                        value={a.price_tag || ""}
                        onChange={(e) => setAnnotations((rows) => rows.map((r) => (r.id === a.id ? { ...r, price_tag: e.target.value } : r)))}
                        onBlur={(e) => void patchAnnotation(a.id, { price_tag: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="input"
                        style={{ width: 100 }}
                        value={a.category || ""}
                        onChange={(e) => setAnnotations((rows) => rows.map((r) => (r.id === a.id ? { ...r, category: e.target.value } : r)))}
                        onBlur={(e) => void patchAnnotation(a.id, { category: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="input"
                        style={{ width: 120 }}
                        value={a.note || ""}
                        onChange={(e) => setAnnotations((rows) => rows.map((r) => (r.id === a.id ? { ...r, note: e.target.value } : r)))}
                        onBlur={(e) => void patchAnnotation(a.id, { note: e.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        className="input"
                        style={{ width: 100 }}
                        value={a.group_id || ""}
                        onChange={(e) => void patchAnnotation(a.id, { group_id: e.target.value || null })}
                      >
                        <option value="">—</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="muted">{a.source_folder_path}</td>
                    <td>{a.present ? "✓" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
