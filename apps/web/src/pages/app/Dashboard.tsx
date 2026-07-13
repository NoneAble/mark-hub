import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";
import { QrCodeModal, faviconOf, hostnameOf } from "@markhub/ui";

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return v.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

export function Dashboard() {
  const { api } = useAuth();
  const { t } = useI18n();
  const [folders, setFolders] = useState<any[]>([]);
  const [bookmarks, setBookmarks] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [density, setDensity] = useState("comfortable");
  const [rootFolderId, setRootFolderId] = useState<string | null>(null);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [collectionBoard, setCollectionBoard] = useState("");
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const home = await api.get<{ folders: any[]; bookmarks: any[] }>("/nav/home");
      setFolders(home.folders);
      setBookmarks(home.bookmarks);
      const settings = await api.get<any>("/settings").catch(() => ({}));
      if (settings.card_density) setDensity(settings.card_density);
      if (settings.wallpaper) {
        document.body.style.backgroundImage = `url(${settings.wallpaper})`;
        document.body.style.backgroundSize = "cover";
      }
      const root = settings.root_folder_id || null;
      setRootFolderId(root);
      if (root) setSelected(root);
      const pinned = asStringArray(settings.pinned_folder_ids);
      setPinnedIds(pinned);
      const expanded = asStringArray(settings.expanded_folder_ids);
      // Default: expand pinned + root ancestors; if empty, expand nothing (collapsed tree)
      setExpandedIds(new Set(expanded.length ? expanded : pinned));
      if (settings.collection_board_name) setCollectionBoard(String(settings.collection_board_name));
      setPrefsLoaded(true);
    })();
  }, [api]);

  async function persistExpanded(next: Set<string>) {
    setExpandedIds(next);
    try {
      await api.put("/settings", { expanded_folder_ids: [...next] });
    } catch {
      /* best-effort */
    }
  }

  function toggleExpand(id: string) {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    void persistExpanded(next);
  }

  const treeRoots = useMemo(() => {
    const byParent = new Map<string | null, any[]>();
    for (const f of folders) {
      const list = byParent.get(f.parent_id) || [];
      list.push(f);
      byParent.set(f.parent_id, list);
    }
    return byParent;
  }, [folders]);

  const pinnedFolders = useMemo(
    () => pinnedIds.map((id) => folders.find((f) => f.id === id)).filter(Boolean),
    [pinnedIds, folders],
  );

  const shown = bookmarks.filter((b) => {
    if (selected && b.folder_id !== selected) return false;
    if (!q) return !b.is_archived;
    const qq = q.toLowerCase();
    return (
      b.title.toLowerCase().includes(qq) ||
      b.url.toLowerCase().includes(qq) ||
      (b.description || "").toLowerCase().includes(qq)
    );
  });

  const gap = density === "compact" ? 8 : density === "spacious" ? 18 : 12;
  const treeStartParent = rootFolderId || null;

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <h1 className="page-title" style={{ margin: 0 }}>
          {collectionBoard || t("workbench")}
        </h1>
        <input
          className="input"
          style={{ maxWidth: 280 }}
          placeholder={t("search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="dashboard-search"
        />
      </div>
      {prefsLoaded && (rootFolderId || pinnedIds.length || collectionBoard) ? (
        <div className="muted" style={{ marginBottom: 8 }} data-testid="dashboard-prefs">
          {rootFolderId ? `root=${rootFolderId.slice(0, 8)}… ` : ""}
          {pinnedIds.length ? `pinned=${pinnedIds.length} ` : ""}
          {collectionBoard ? `board=${collectionBoard}` : ""}
        </div>
      ) : null}
      {pinnedFolders.length ? (
        <div className="row wrap" style={{ marginBottom: 12 }} data-testid="pinned-folders">
          {pinnedFolders.map((f: any) => (
            <button
              key={f.id}
              type="button"
              className="btn"
              style={{
                borderColor: selected === f.id ? "var(--accent)" : undefined,
              }}
              onClick={() => setSelected(f.id)}
            >
              📌 {f.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="dashboard-grid">
        <div className="card" style={{ padding: 12 }}>
          <div className="muted" style={{ marginBottom: 8 }}>
            {t("folders")}
          </div>
          <FolderTree
            byParent={treeRoots}
            parentId={treeStartParent}
            selected={selected}
            onSelect={setSelected}
            expanded={expandedIds}
            onToggle={toggleExpand}
            startAsRoots={!!rootFolderId}
            rootFolderId={rootFolderId}
          />
          <button
            className="btn"
            style={{ marginTop: 8, width: "100%" }}
            type="button"
            onClick={() => setSelected(rootFolderId)}
            data-testid="dashboard-all"
          >
            {rootFolderId ? "Root" : "All"}
          </button>
        </div>
        <div className="grid-cards" style={{ gap }} data-testid="bookmark-cards">
          {shown.map((b) => (
            <div key={b.id} className="bm-card" data-testid={`bm-card-${b.id}`}>
              <div className="row" style={{ gap: 8 }}>
                <img src={faviconOf(b.url)} width={18} height={18} alt="" />
                <a href={b.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600, color: "inherit" }}>
                  {b.title}
                </a>
              </div>
              <div className="muted">{hostnameOf(b.url)}</div>
              <div className="row">
                <span className="badge">{b.visibility}</span>
                {b.is_favorite ? <span className="badge">★</span> : null}
                <button
                  className="btn"
                  type="button"
                  style={{ marginLeft: "auto", padding: "4px 8px", fontSize: 12 }}
                  data-testid={`qr-${b.id}`}
                  onClick={() => setQrUrl(b.url)}
                >
                  QR
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <QrCodeModal url={qrUrl || ""} open={!!qrUrl} onClose={() => setQrUrl(null)} />
    </div>
  );
}

function FolderTree({
  byParent,
  parentId,
  selected,
  onSelect,
  expanded,
  onToggle,
  depth = 0,
  startAsRoots = false,
  rootFolderId = null,
}: {
  byParent: Map<string | null, any[]>;
  parentId: string | null;
  selected: string | null;
  onSelect: (id: string) => void;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  depth?: number;
  startAsRoots?: boolean;
  rootFolderId?: string | null;
}) {
  // When a root folder is set, show that folder as the top node then its children
  let kids: any[] = [];
  if (depth === 0 && startAsRoots && rootFolderId) {
    // Find the root folder object among all folders
    for (const list of byParent.values()) {
      const found = list.find((f) => f.id === rootFolderId);
      if (found) {
        kids = [found];
        break;
      }
    }
  } else {
    kids = byParent.get(parentId) || [];
  }

  return (
    <div>
      {kids.map((f) => {
        const hasChildren = (byParent.get(f.id) || []).length > 0;
        const isOpen = expanded.has(f.id);
        return (
          <div key={f.id} data-testid={`folder-node-${f.id}`}>
            <div className="row" style={{ gap: 2 }}>
              {hasChildren ? (
                <button
                  type="button"
                  className="btn"
                  style={{ padding: "2px 6px", fontSize: 11 }}
                  aria-label={isOpen ? "collapse" : "expand"}
                  data-testid={`folder-toggle-${f.id}`}
                  onClick={() => onToggle(f.id)}
                >
                  {isOpen ? "▾" : "▸"}
                </button>
              ) : (
                <span style={{ width: 24 }} />
              )}
              <button
                type="button"
                onClick={() => onSelect(f.id)}
                style={{
                  display: "block",
                  flex: 1,
                  textAlign: "left",
                  border: "none",
                  background: selected === f.id ? "var(--accent-weak)" : "transparent",
                  color: "var(--text)",
                  padding: "6px 8px",
                  paddingLeft: 8 + depth * 12,
                  borderRadius: 6,
                  fontSize: 13,
                }}
              >
                {f.name}
                {f.is_system ? " ⚙" : ""}
              </button>
            </div>
            {hasChildren && isOpen ? (
              <FolderTree
                byParent={byParent}
                parentId={f.id}
                selected={selected}
                onSelect={onSelect}
                expanded={expanded}
                onToggle={onToggle}
                depth={depth + 1}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
