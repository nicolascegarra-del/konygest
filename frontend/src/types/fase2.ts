/** Tipos del contrato de la fase 2: pedidos de los comerciales (docs/api-fase2.md). */

import type { PriceSource } from "@/types/fase1";

/** Estado de un pedido de venta (no confundir con `OrderStatus` de las órdenes de fabricación). */
export type SalesOrderStatus =
  | "draft"
  | "pending"
  | "rejected"
  | "confirmed"
  | "planned"
  | "loaded"
  | "delivered"
  | "invoiced"
  | "cancelled";

/** Acciones que el usuario actual puede hacer ya sobre el pedido (`allowed_actions`). */
export type SalesOrderAction = "edit" | "submit" | "validate" | "reject" | "cancel";

/** Origen del precio de una línea: el de la consulta de precios o «manual» si se cambió. */
export type LinePriceSource = Exclude<PriceSource, "none"> | "manual";

export interface SalesOrderSummary {
  id: string;
  number: string;
  status: SalesOrderStatus;
  customer_id: string;
  customer_code: string;
  customer_name: string;
  farm_id: string;
  farm_name: string;
  sales_rep_id: string | null;
  sales_rep_name: string | null;
  requested_date: string;
  total_kg: number;
  total_amount: number;
  line_count: number;
  /** Alguna línea tiene precio por debajo de su `reference_price`. */
  has_manual_price: boolean;
  created_at: string;
  submitted_at: string | null;
  updated_at: string;
}

export interface SalesOrderLine {
  id: string;
  position: number;
  item_id: string;
  item_code: string;
  item_name: string;
  quantity_kg: number;
  unit_price: number;
  price_source: LinePriceSource;
  reference_price: number | null;
  amount: number;
  farm_silo: string;
  notes: string;
}

export interface SalesOrderDetail extends SalesOrderSummary {
  notes: string;
  /** Motivo del último rechazo o de la cancelación. */
  status_reason: string;
  validated_by_name: string | null;
  validated_at: string | null;
  created_by_name: string | null;
  allowed_actions: SalesOrderAction[];
  lines: SalesOrderLine[];
}

export interface SalesOrderLinePayload {
  item_id: string;
  quantity_kg: number;
  /** `null` → el backend aplica el precio del cliente (negociado > tarifa > general). */
  unit_price: number | null;
  farm_silo?: string;
  notes: string;
}

export interface SalesOrderPayload {
  customer_id: string;
  farm_id: string;
  requested_date: string;
  /** Se omite si el usuario es de alcance «propios» o si se deja «el del cliente». */
  sales_rep_id?: string | null;
  notes: string;
  submit: boolean;
  lines: SalesOrderLinePayload[];
}

export interface ValidatePayload {
  notes?: string;
  force?: boolean;
}

export interface ReasonPayload {
  reason: string;
}

export interface CreditCheck {
  /** `null` = sin límite (nunca se supera). */
  credit_limit: number | null;
  outstanding_amount: number;
  order_amount: number;
  available: number | null;
  exceeded: boolean;
}

export interface PriceCheck {
  line_id: string;
  item_code: string;
  item_name: string;
  unit_price: number;
  reference_price: number;
  difference_pct: number;
}

export interface StockCheck {
  item_id: string;
  item_code: string;
  item_name: string;
  requested_kg: number;
  stock_kg: number;
  committed_kg: number;
  short: boolean;
}

export interface OrderChecks {
  credit: CreditCheck;
  prices: PriceCheck[];
  stock: StockCheck[];
}

/** Fila de `GET /orders/summary`: pedidos y kilos por día de entrega. */
export interface OrderDaySummary {
  date: string;
  orders: number;
  total_kg: number;
}
