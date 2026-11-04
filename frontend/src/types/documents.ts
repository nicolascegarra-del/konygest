/** Tipos del destino de documentos de la empresa (`docs/api-documentos.md`). */

export type StorageProvider = "platform" | "google_drive" | "onedrive" | "smb";

/** Proveedores con conexión OAuth (botón «Conectar con Google/Microsoft»). */
export type OAuthProvider = "google_drive" | "onedrive";

export type StorageStatus = "ok" | "error" | "not_configured";

export interface GoogleDriveSettings {
  root_folder_name: string;
  shared_drive_id: string | null;
}

export interface OneDriveSettings {
  root_path: string;
  site_url: string | null;
}

export interface SmbSettings {
  server: string;
  share: string;
  root_path: string;
  username: string;
  domain: string | null;
  port: number | null;
}

/** `GET /tenant/storage`: configuración actual sin secretos. */
export interface TenantStorage {
  provider: StorageProvider;
  /** Depende del proveedor; vacío o `null` en `platform`. */
  settings: Record<string, unknown> | null;
  connected_account: string | null;
  has_secret: boolean;
  status: StorageStatus;
  last_error: string | null;
  last_checked_at: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
  available_providers: StorageProvider[];
}

/** Cuerpo de `PUT /tenant/storage`. */
export type TenantStorageUpdate =
  | { provider: "google_drive"; settings: GoogleDriveSettings }
  | { provider: "onedrive"; settings: OneDriveSettings }
  | { provider: "smb"; settings: SmbSettings; password?: string };

/** `POST /tenant/storage/test`. */
export interface StorageTestResult {
  ok: boolean;
  message: string;
  elapsed_ms: number;
}

/** `POST /tenant/storage/oauth/{provider}/start`. */
export interface OAuthStartResult {
  authorize_url: string;
}

/** Tipos de documento; las fases siguientes añaden facturas, abonos… */
export type DocumentKind = "delivery_note" | "loading_order" | "invoice" | "credit_note";

/** Fila de `GET /tenant/storage/documents`. */
export interface StoredDocument {
  id: string;
  kind: DocumentKind | (string & {});
  number: string;
  filename: string;
  provider: StorageProvider;
  size: number;
  created_at: string;
  source_type: string | null;
  source_id: string | null;
}
