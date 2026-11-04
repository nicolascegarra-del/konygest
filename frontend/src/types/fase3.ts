/** Tipos del contrato de la fase 3: logística, cargas, pesada y albarán (docs/api-fase3.md). */

import type { SalesOrderStatus, SalesOrderSummary } from "@/types/fase2";

export type LoadStatus = "planned" | "ready" | "loaded" | "delivered" | "cancelled";

/** Acciones que el usuario actual puede hacer ya sobre la carga (`allowed_actions`). */
export type LoadAction = "edit" | "release" | "unrelease" | "load" | "deliver" | "cancel";

/** Fila del listado de cargas (`LoadSummary`). */
export interface LoadSummary {
  id: string;
  number: string;
  load_date: string;
  status: LoadStatus;
  truck_id: string;
  truck_plate: string;
  carrier_name: string | null;
  driver_id: string | null;
  driver_name: string | null;
  capacity_kg: number;
  planned_kg: number;
  stop_count: number;
  /** Nombres de cliente en el orden de descarga. */
  customers: string[];
  created_at: string;
  updated_at: string;
}

export interface LoadStop {
  id: string;
  sequence: number;
  order_id: string;
  order_number: string;
  order_status: SalesOrderStatus;
  customer_name: string;
  farm_name: string;
  farm_rega: string;
  farm_city: string;
  requested_date: string;
  total_kg: number;
  delivery_note_number: string | null;
  delivery_note_ready: boolean;
  delivered_at: string | null;
  received_by: string;
  delivery_notes: string;
}

/** Kilos de una línea de pedido en un compartimento (`load_item`). */
export interface LoadItem {
  id: string;
  stop_id: string;
  order_line_id: string;
  /** Desde 1: índice en `compartments`. */
  compartment: number;
  item_id: string;
  item_code: string;
  item_name: string;
  farm_silo: string;
  planned_kg: number;
  actual_kg: number | null;
  silo_id: string | null;
  silo_name: string | null;
  lot: string | null;
}

export interface LoadDetail extends LoadSummary {
  notes: string;
  status_reason: string;
  gross_kg: number | null;
  tare_kg: number | null;
  released_at: string | null;
  loaded_at: string | null;
  loaded_by_name: string | null;
  delivered_at: string | null;
  created_by_name: string | null;
  allowed_actions: LoadAction[];
  /** Capacidad en kg de cada compartimento del camión. */
  compartments: number[];
  stops: LoadStop[];
  items: LoadItem[];
}

export interface PendingOrderLine {
  id: string;
  item_id: string;
  item_code: string;
  item_name: string;
  quantity_kg: number;
  farm_silo: string;
}

/** Pedido confirmado sin carga (`GET /logistics/pending-orders`). */
export interface PendingOrder extends SalesOrderSummary {
  farm_city: string;
  lines: PendingOrderLine[];
}

export interface LoadStopPayload {
  order_id: string;
  sequence: number;
}

export interface LoadItemPayload {
  order_line_id: string;
  compartment: number;
  planned_kg: number;
}

export interface LoadPayload {
  load_date: string;
  truck_id: string;
  driver_id: string | null;
  notes: string;
  stops: LoadStopPayload[];
  /** Si se omite, el servidor reparte automáticamente. */
  items?: LoadItemPayload[];
}

export interface WeighingItemPayload {
  /** Id del `load_item`. */
  item_id: string;
  actual_kg: number;
  silo_id: string;
  lot: string | null;
}

export interface WeighingPayload {
  gross_kg?: number;
  tare_kg?: number;
  items: WeighingItemPayload[];
}

export interface DeliverPayload {
  received_by?: string;
  delivered_at?: string;
  notes?: string;
}
