/** Tipos del contrato de la API de Konygest (docs/api-fase0.md). */

export type Scope = "own" | "all";
export type PlatformRole = "superadmin" | "support";
export type WidgetSize = "sm" | "md" | "lg";
export type TenantStatus = "trial" | "active" | "past_due" | "disabled";

export interface Me {
  id: string;
  email: string;
  full_name: string;
  tenant: { id: string; name: string } | null;
  platform_role: PlatformRole | null;
  permissions: Record<string, Scope>;
  modules: string[];
  support_mode: boolean;
  read_only: boolean;
  totp_enabled: boolean;
  must_setup_2fa: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface WidgetItem {
  widget: string;
  size: WidgetSize;
}

export interface WidgetCatalogEntry {
  code: string;
  name: string;
  description: string;
}

export interface DashboardResponse {
  layout: WidgetItem[];
  customized: boolean;
  catalog: WidgetCatalogEntry[];
}

export interface LoginResponse {
  access_token: string;
  user: Me;
}

export interface InvitationInfo {
  email: string;
  full_name: string;
  tenant_name: string;
}

export interface TwoFactorSetup {
  secret: string;
  otpauth_uri: string;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NotificationPreference {
  type: string;
  name: string;
  in_app: boolean;
  email: boolean;
  push: boolean;
}

export interface TenantModule {
  code: string;
  name: string;
  description: string;
  available: boolean;
  enabled: boolean;
}

export interface Tenant {
  id: string;
  name: string;
  tax_id: string | null;
  status: TenantStatus;
  require_2fa: boolean;
  plan_code?: string | null;
  modules: TenantModule[];
}

export interface TenantSummary {
  users: number;
  active_users: number;
  roles: number;
  modules_enabled: string[];
}

export interface EmailConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  has_password: boolean;
  use_tls: boolean;
  from_email: string;
  from_name: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  user_email: string | null;
  entity: string | null;
  entity_id: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
}

export interface RoleRef {
  id: string;
  name: string;
}

export interface UserRow {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  roles: RoleRef[];
  last_login_at: string | null;
  pending_invite: boolean;
}

export interface PermissionDef {
  code: string;
  area: string;
  name: string;
  module: string;
  scoped: boolean;
  available: boolean;
}

export interface Role {
  id: string;
  name: string;
  description: string | null;
  user_count: number;
  permissions: Record<string, Scope>;
  dashboard_layout: WidgetItem[];
}

export interface RolePayload {
  name: string;
  description: string;
  permissions: Record<string, Scope>;
  dashboard_layout: WidgetItem[];
}

export interface AdminStats {
  tenants: Partial<Record<TenantStatus, number>>;
  users: number;
  active_users_30d: number;
}

export interface AdminTenantRow {
  id: string;
  name: string;
  tax_id: string | null;
  status: TenantStatus;
  plan_code: string | null;
  users: number;
  created_at: string;
  last_activity_at: string | null;
}

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    field?: string | null;
    request_id?: string | null;
  };
}
