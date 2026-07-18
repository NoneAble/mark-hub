import { useMemo, useState } from "react";
import type { ApiClient } from "@markhub/api-client";
import { useI18n } from "../i18n";
import { LetterAvatar } from "./ui";
import {
  Combobox,
  ComboOption,
  FaviconImg,
  Field,
  Segmented,
  Switch,
  TagPicker,
} from "./form";

export type FolderLike = {
  id: string;
  name: string;
  parent_id?: string | null;
  is_system?: boolean;
};

export type TagLike = { id?: string; name: string };

export type BookmarkDraft = {
  folder_id: string; // "" = no category (shown under "All"); "__new__:<name>" = create on save
  url: string;
  title: string;
  description: string;
  icon: string;
  tags: string[];
  sort_order: string;
  visibility: string;
  is_archived: boolean;
};

export const NEW_PREFIX = "__new__:";

export function emptyDraft(folderId = ""): BookmarkDraft {
  return {
    folder_id: folderId,
    url: "",
    title: "",
    description: "",
    icon: "",
    tags: [],
    sort_order: "",
    visibility: "private",
    is_archived: false,
  };
}

export function draftFromBookmark(bm: {
  folder_id?: string;
  url?: string;
  title?: string;
  description?: string | null;
  icon?: string | null;
  tags?: Array<string | { name: string }> | null;
  sort_order?: number;
  visibility?: string;
  is_archived?: boolean;
}): BookmarkDraft {
  return {
    folder_id: bm.folder_id || "",
    url: bm.url || "",
    title: bm.title || "",
    description: bm.description || "",
    icon: bm.icon || "",
    tags: (bm.tags || []).map((x) => (typeof x === "string" ? x : x.name)).filter(Boolean),
    sort_order: bm.sort_order != null ? String(bm.sort_order) : "",
    visibility: bm.visibility || "private",
    is_archived: !!bm.is_archived,
  };
}

/**
 * Unified add/edit bookmark form (spec order): category combobox (creatable) →
 * URL + auto-fetch → title → description → icon → tags multi-select →
 * sort + visibility. Handles save internally, including creating a pending
 * category.
 */
export function BookmarkForm({
  api,
  formId,
  initial,
  editingId,
  folders,
  tags,
  onSaved,
  onNotice,
  showArchived = false,
}: {
  api: ApiClient;
  formId: string;
  initial: BookmarkDraft;
  editingId?: string | null;
  folders: FolderLike[];
  tags: TagLike[];
  /** Called after a successful save. */
  onSaved: () => void;
  /** Toast-style feedback (fetch results, save errors). */
  onNotice?: (msg: string) => void;
  showArchived?: boolean;
}) {
  const { t } = useI18n();
  // The system folder is not a real category in the UI — normalize it to "".
  const [draft, setDraft] = useState<BookmarkDraft>(() =>
    folders.some((f) => f.is_system && f.id === initial.folder_id)
      ? { ...initial, folder_id: "" }
      : initial,
  );
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingTags, setPendingTags] = useState<string[]>([]);

  const folderOptions = useMemo<ComboOption[]>(() => {
    const out: ComboOption[] = [{ value: "", label: t("allFolders") }];
    const byParent = new Map<string | null, FolderLike[]>();
    for (const f of folders) {
      const k = f.parent_id ?? null;
      byParent.set(k, [...(byParent.get(k) || []), f]);
    }
    const walk = (parent: string | null, pad: number) => {
      for (const f of byParent.get(parent) || []) {
        if (f.is_system) {
          // Skip the system folder itself but keep folders nested under it
          walk(f.id, pad);
          continue;
        }
        out.push({ value: f.id, label: f.name, pad });
        walk(f.id, pad + 14);
      }
    };
    walk(null, 0);
    if (draft.folder_id.startsWith(NEW_PREFIX)) {
      out.push({
        value: draft.folder_id,
        label: draft.folder_id.slice(NEW_PREFIX.length),
        isNew: true,
      });
    }
    return out;
  }, [folders, draft.folder_id, t]);

  const tagOptions = useMemo(() => {
    const known = new Set(tags.map((x) => x.name));
    const out = tags.map((x) => ({ name: x.name, isNew: false }));
    for (const name of pendingTags) {
      if (!known.has(name)) out.push({ name, isNew: true });
    }
    return out;
  }, [tags, pendingTags]);

  async function autoFetch() {
    const url = draft.url.trim();
    if (!url || fetching) return;
    setFetching(true);
    try {
      const meta = await api.post<{
        url: string;
        title: string;
        description: string;
        icon: string;
      }>("/metadata", { url });
      setDraft((d) => ({
        ...d,
        url: meta.url || d.url,
        title: meta.title || d.title,
        description: meta.description || d.description,
        icon: meta.icon || d.icon,
      }));
      onNotice?.(t("fetchOk"));
    } catch (e) {
      onNotice?.(`${t("fetchFail")}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFetching(false);
    }
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      let folderId: string | undefined = draft.folder_id || undefined;
      if (folderId?.startsWith(NEW_PREFIX)) {
        const created = await api.post<{ id: string }>("/folders", {
          name: folderId.slice(NEW_PREFIX.length),
          visibility: "private",
          parent_id: null,
        });
        folderId = created.id;
      }
      const payload: Record<string, unknown> = {
        title: draft.title.trim() || draft.url.trim(),
        url: draft.url.trim(),
        description: draft.description,
        folder_id: folderId,
        visibility: draft.visibility,
        tags: draft.tags,
      };
      const icon = draft.icon.trim();
      if (editingId) payload.icon = icon; // explicit clear allowed on edit
      else if (icon) payload.icon = icon;
      if (showArchived) payload.is_archived = draft.is_archived;
      const sort = draft.sort_order.trim();
      if (sort !== "" && !Number.isNaN(Number(sort))) payload.sort_order = Number(sort);

      if (editingId) await api.patch(`/bookmarks/${editingId}`, payload);
      else await api.post("/bookmarks", payload);
      onSaved();
    } catch (e) {
      onNotice?.(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      id={formId}
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label={t("category")}>
        <Combobox
          value={draft.folder_id}
          options={folderOptions}
          creatable
          onCreate={(name) => {
            const v = NEW_PREFIX + name;
            setDraft((d) => ({ ...d, folder_id: v }));
            return v;
          }}
          onChange={(v) => setDraft((d) => ({ ...d, folder_id: v }))}
          placeholder={t("categoryPh")}
          testId="bm-form-category"
        />
      </Field>

      <Field label={t("url")}>
        <div className="row" style={{ flexWrap: "nowrap", gap: 8 }}>
          <input
            className="input input-mono"
            style={{ flex: 1 }}
            value={draft.url}
            placeholder={t("urlPh")}
            onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
            required
            data-testid="bm-form-url"
          />
          <button
            type="button"
            className="btn btn-soft"
            style={{ flex: "none", minHeight: 40 }}
            disabled={!draft.url.trim() || fetching}
            onClick={() => void autoFetch()}
            data-testid="bm-form-fetch"
          >
            {fetching ? t("fetching") : `⚡ ${t("autoFetch")}`}
          </button>
        </div>
      </Field>

      <Field label={t("title")}>
        <input
          className="input"
          value={draft.title}
          placeholder={t("title")}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          data-testid="bm-form-title"
        />
      </Field>

      <Field label={t("description")}>
        <textarea
          className="input"
          rows={3}
          value={draft.description}
          placeholder={t("descriptionPh")}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          data-testid="bm-form-desc"
        />
      </Field>

      <Field label={t("icon")}>
        <div className="row" style={{ flexWrap: "nowrap", gap: 8 }}>
          <span className="bm-form-icon-preview">
            {draft.icon.trim() ? (
              <FaviconImg src={draft.icon.trim()} size={38} radius={8} />
            ) : (
              <LetterAvatar url={draft.url || draft.title || "?"} size="sm" />
            )}
          </span>
          <input
            className="input input-mono"
            style={{ flex: 1 }}
            value={draft.icon}
            placeholder={t("iconPh")}
            onChange={(e) => setDraft((d) => ({ ...d, icon: e.target.value }))}
            data-testid="bm-form-icon"
          />
        </div>
      </Field>

      <Field label={t("tags")}>
        <TagPicker
          selected={draft.tags}
          options={tagOptions}
          onChange={(names) => setDraft((d) => ({ ...d, tags: names }))}
          onCreate={(name) => setPendingTags((list) => (list.includes(name) ? list : [...list, name]))}
          placeholder={t("tagsPh")}
        />
      </Field>

      <div className="row" style={{ gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label={t("sort")}>
          <input
            className="input"
            type="number"
            style={{ width: 100 }}
            value={draft.sort_order}
            placeholder="0"
            onChange={(e) => setDraft((d) => ({ ...d, sort_order: e.target.value }))}
            data-testid="bm-form-sort"
          />
        </Field>
        <Field label={t("visibility")}>
          <Segmented
            value={draft.visibility}
            options={[
              { value: "private", label: `🔒 ${t("private")}` },
              { value: "unlisted", label: `🔗 ${t("unlisted")}` },
              { value: "public", label: `🌐 ${t("public")}` },
            ]}
            onChange={(v) => setDraft((d) => ({ ...d, visibility: v }))}
          />
        </Field>
        {showArchived ? (
          <Field label={t("archive")}>
            <div style={{ minHeight: 34, display: "flex", alignItems: "center" }}>
              <Switch
                checked={draft.is_archived}
                onChange={(v) => setDraft((d) => ({ ...d, is_archived: v }))}
              />
            </div>
          </Field>
        ) : null}
      </div>
      {saving ? <div className="muted-sm">{t("save")}…</div> : null}
    </form>
  );
}
