import type { TenantStatus } from "@/types/api";

export const TENANT_STATUS_LABELS: Record<TenantStatus, string> = {
  trial: "En prueba",
  active: "Activa",
  past_due: "Impago",
  disabled: "Desactivada",
};

export const TENANT_STATUS_VARIANTS: Record<TenantStatus, "secondary" | "success" | "warning" | "destructive"> = {
  trial: "secondary",
  active: "success",
  past_due: "warning",
  disabled: "destructive",
};

export const TENANT_STATUSES: TenantStatus[] = ["trial", "active", "past_due", "disabled"];
