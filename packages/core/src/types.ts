/** Shared domain types for MarkHub (OpenAPI-aligned). */

export type Visibility = "private" | "unlisted" | "public";

export type FolderDeleteMode =
  | "move_to_parent"
  | "move_to_inbox"
  | "cascade_soft_delete";

export type ImportStrategy = "skip_duplicate" | "merge" | "replace_all";

export type LinkStatus = "unknown" | "ok" | "broken" | "redirect" | "blocked";

export type OpEntityType =
  | "bookmark"
  | "folder"
  | "tag"
  | "reorder"
  | "settings";

export type OpAction =
  | "create"
  | "update"
  | "delete"
  | "restore"
  | "reorder"
  | "soft_delete";

export interface Bookmark {
  id: string;
  user_id: string;
  folder_id: string;
  title: string;
  url: string;
  url_normalized: string;
  description: string | null;
  visibility: Visibility;
  is_favorite: boolean;
  is_archived: boolean;
  sort_order: number;
  ai_summary: string | null;
  ai_category: string | null;
  link_status: LinkStatus;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  tags?: Tag[];
}

export interface Folder {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  visibility: Visibility;
  is_system: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Tag {
  id: string;
  user_id: string;
  name: string;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface OpLogRow {
  id: number;
  user_id: string;
  entity_type: OpEntityType;
  entity_id: string;
  action: OpAction;
  snapshot: Record<string, unknown> | null;
  created_at: string;
}

export interface S3BackupConfig {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  key_prefix: string;
  access_key_id: string;
  secret_access_key: string;
  keep_backups: number;
  backup_time: string;
  last_backup_at?: string;
  last_backup_key?: string;
  force_path_style?: boolean;
}

export interface WebDavBackupConfig {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  path: string;
  keep_backups: number;
  backup_time: string;
  last_backup_at?: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ChangesResponse {
  changes: OpLogRow[];
  next_cursor: number | null;
  has_more: boolean;
}

export interface NavNode {
  type: "folder" | "bookmark";
  id: string;
  name?: string;
  title?: string;
  url?: string;
  description?: string | null;
  visibility: Visibility;
  children?: NavNode[];
  sort_order: number;
}
