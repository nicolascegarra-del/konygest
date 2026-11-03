import type { TenantStatus } from "@/types/api";
import type { ItemKind, MovementKind, OrderStatus, PriceSource, SiloKind } from "@/types/fase1";
import type { LinePriceSource, SalesOrderStatus } from "@/types/fase2";

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

export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  product: "Pienso",
  raw_material: "Materia prima",
};

export const SILO_KIND_LABELS: Record<SiloKind, string> = {
  silo: "Silo",
  warehouse: "Almacén",
};

export const MOVEMENT_KIND_LABELS: Record<MovementKind, string> = {
  raw_material_in: "Entrada de materia prima",
  production: "Fabricación",
  consumption: "Consumo",
  load_out: "Carga de camión",
  adjustment: "Ajuste",
  inventory: "Inventario",
};

export const MOVEMENT_KINDS = Object.keys(MOVEMENT_KIND_LABELS) as MovementKind[];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  planned: "Prevista",
  in_progress: "En curso",
  done: "Terminada",
  cancelled: "Cancelada",
};

export const ORDER_STATUS_VARIANTS: Record<OrderStatus, "secondary" | "success" | "warning" | "destructive"> = {
  planned: "secondary",
  in_progress: "warning",
  done: "success",
  cancelled: "destructive",
};

export const ORDER_STATUSES = Object.keys(ORDER_STATUS_LABELS) as OrderStatus[];

export const PRICE_SOURCE_LABELS: Record<PriceSource, string> = {
  customer: "Precio negociado",
  price_list: "Tarifa del cliente",
  base: "Precio general",
  none: "Sin precio",
};

// ─── Pedidos de venta (fase 2) ─────────────────────

export type BadgeVariant = "default" | "secondary" | "outline" | "success" | "warning" | "destructive";

export const SALES_ORDER_STATUS_LABELS: Record<SalesOrderStatus, string> = {
  draft: "Borrador",
  pending: "Pendiente de validar",
  rejected: "Rechazado",
  confirmed: "Confirmado",
  planned: "Planificado",
  loaded: "Cargado",
  delivered: "Entregado",
  invoiced: "Facturado",
  cancelled: "Cancelado",
};

export const SALES_ORDER_STATUS_VARIANTS: Record<SalesOrderStatus, BadgeVariant> = {
  draft: "outline",
  pending: "warning",
  rejected: "destructive",
  confirmed: "success",
  planned: "secondary",
  loaded: "secondary",
  delivered: "success",
  invoiced: "default",
  cancelled: "destructive",
};

export const SALES_ORDER_STATUSES = Object.keys(SALES_ORDER_STATUS_LABELS) as SalesOrderStatus[];

/** Etiqueta corta del origen del precio de una línea de pedido. */
export const LINE_PRICE_SOURCE_LABELS: Record<LinePriceSource, string> = {
  customer: "Negociado",
  price_list: "Tarifa",
  base: "General",
  manual: "Manual",
};

export const LINE_PRICE_SOURCE_VARIANTS: Record<LinePriceSource, BadgeVariant> = {
  customer: "success",
  price_list: "secondary",
  base: "outline",
  manual: "warning",
};
