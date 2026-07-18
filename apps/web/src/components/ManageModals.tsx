import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "@markhub/api-client";
import { useI18n } from "../i18n";
import { Modal } from "./ui";
import { Combobox, Segmented, useConfirm, type ComboOption } from "./form";

export type ManagedFolder = {
  id: string;
  name: string;
  parent_id: string | null;
  visibility: string;
  is_system?: boolean;
  sort_order?: number;
};

function useVisOptions() {
  const { t } = useI18n();
  return [
    { value: "private", label: `🔒 ${t("private")}` },
    { value: "unlisted", label: `🔗 ${t("unlisted")}` },
    { value: "public", label: `🌐 ${t("public")}` },
  ];
}

/** Create (folder = null) or edit a category. System folders: rename only (KD-35). */
export function FolderModal({
  open,
  api,
  folder,
  folders,
  defaultParentId = "",
  onClose,
  onSaved,
  onNotice,
}: {
  open: boolean;
  api: ApiClient;
  folder: ManagedFolder | null;
  folders: ManagedFolder[];
  defaultParentId?: string;
  onClose: () => void;
  onSaved: () => void;
  onNotice?: (msg: string) => void;
}) {
  const { t } = useI18n();
  const visOptions = useVisOptions();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(folder?.name || "");
    setParentId(folder?.parent_id || (folder ? "" : defaultParentId));
    setVisibility(folder?.visibility || "private");
  }, [open, folder, defaultParentId]);

  const descendants = useMemo(() => {
    // A folder cannot become a child of itself or of its own subtree.
    const out = new Set<string>();
    if (!folder) return out;
    out.add(folder.id);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) {
          out.add(f.id);
          grew = true;
        }
      }
    }
    return out;
  }, [folder, folders]);

  const parentOptions = useMemo<ComboOption[]>(
    () => [
      { value: "", label: t("root") },
      ...folders
        .filter((f) => !f.is_system && !descendants.has(f.id))
        .map((f) => ({ value: f.id, label: f.name })),
    ],
    [folders, descendants, t],
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      if (!folder) {
        await api.post("/folders", { name, visibility, parent_id: parentId || null });
      } else {
        const body: Record<string, unknown> = { name };
        if (!folder.is_system) {
          body.visibility = visibility;
          body.parent_id = parentId || null;
        }
        await api.patch(`/folders/${folder.id}`, body);
      }
      onSaved();
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title={folder ? t("editFolder") : t("newCategory")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="submit" form="folder-modal-form" className="btn btn-primary" disabled={saving}>
            {t("save")}
          </button>
        </>
      }
    >
      <form id="folder-modal-form" className="stack" onSubmit={(e) => void onSubmit(e)}>
        <label className="field">
          {t("title")}
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            data-testid="folder-form-name"
          />
        </label>
        {!folder || !folder.is_system ? (
          <>
            <div className="field">
              <span className="field-label">{t("parentCategory")}</span>
              <Combobox
                value={parentId}
                options={parentOptions}
                onChange={setParentId}
                placeholder={t("parentCategory")}
              />
            </div>
            <div className="field">
              <span className="field-label">{t("visibility")}</span>
              <Segmented value={visibility} options={visOptions} onChange={setVisibility} />
            </div>
          </>
        ) : (
          <span className="muted">{t("systemRenameOnly")}</span>
        )}
      </form>
    </Modal>
  );
}

function DeleteModePicker({ onPick }: { onPick: (mode: string) => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState("move_to_inbox");
  const opts = [
    { value: "move_to_inbox", label: t("deleteModeInbox") },
    { value: "move_to_parent", label: t("deleteModeParent") },
    { value: "cascade_soft_delete", label: t("deleteModeCascade") },
  ];
  return (
    <div className="stack" style={{ gap: 6, marginTop: 12 }}>
      <span className="field-label">{t("deleteMode")}</span>
      {opts.map((o) => (
        <label key={o.value} className="row" style={{ gap: 8, fontSize: 13, cursor: "pointer" }}>
          <input
            type="radio"
            name="folder-delete-mode"
            checked={mode === o.value}
            onChange={() => {
              setMode(o.value);
              onPick(o.value);
            }}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** Confirm + delete a folder, letting the user pick what happens to its contents. */
export function useDeleteFolder(api: ApiClient) {
  const { t } = useI18n();
  const { confirm, confirmElement } = useConfirm();

  async function deleteFolder(f: ManagedFolder): Promise<boolean> {
    if (f.is_system) return false;
    let mode = "move_to_inbox";
    const ok = await confirm({
      title: t("confirmDeleteFolder"),
      message: `${t("confirmDeleteFolder")}「${f.name}」？`,
      danger: true,
      body: (
        <DeleteModePicker
          onPick={(m) => {
            mode = m;
          }}
        />
      ),
    });
    if (!ok) return false;
    await api.delete(`/folders/${f.id}?mode=${mode}`);
    return true;
  }

  return { deleteFolder, deleteFolderElement: confirmElement } as const;
}

/** Rename or delete a tag. */
export function TagModal({
  open,
  api,
  tag,
  usage,
  onClose,
  onChanged,
  onNotice,
}: {
  open: boolean;
  api: ApiClient;
  tag: { id: string; name: string } | null;
  usage: number;
  onClose: () => void;
  onChanged: () => void;
  onNotice?: (msg: string) => void;
}) {
  const { t } = useI18n();
  const { confirm, confirmElement } = useConfirm();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setName(tag?.name || "");
  }, [open, tag]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!tag || saving) return;
    setSaving(true);
    try {
      await api.patch(`/tags/${tag.id}`, { name });
      onChanged();
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!tag) return;
    const ok = await confirm({ message: t("confirmDeleteTag"), danger: true });
    if (!ok) return;
    try {
      await api.delete(`/tags/${tag.id}`);
      onChanged();
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Modal
      open={open}
      title={t("editTag")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-danger" onClick={() => void onDelete()}>
            {t("delete")}
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="submit" form="tag-modal-form" className="btn btn-primary" disabled={saving}>
            {t("save")}
          </button>
        </>
      }
    >
      <form id="tag-modal-form" className="stack" onSubmit={(e) => void onSubmit(e)}>
        <label className="field">
          {t("title")}
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            data-testid="tag-form-name"
          />
        </label>
        <div className="muted-sm">
          {t("usedBy")} {usage} {t("itemsUnit")}
        </div>
      </form>
      {confirmElement}
    </Modal>
  );
}
