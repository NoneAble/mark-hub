/** Shared domain types for MarkHub (OpenAPI-aligned). */

export type Visibility = "private" | "unlisted" | "public";

export type FolderDeleteMode =
  | "move_to_parent"
  | "move_to_inbox"
  | "cascade_soft_delete";

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
