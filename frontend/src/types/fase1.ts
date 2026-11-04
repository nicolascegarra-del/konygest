/** Tipos del contrato de la fase 1: maestros, stock y fabricación (docs/api-fase1.md). */

export type ItemKind = "product" | "raw_material";
export type SiloKind = "silo" | "warehouse";
export type MovementKind = "raw_material_in" | "production" | "consumption" | "load_out" | "adjustment" | "inventory";
export type OrderStatus = "planned" | "in_progress" | "done" | "cancelled";
export type PriceSource = "customer" | "price_list" | "base" | "none";

/** Campos comunes de todas las salidas de maestros. */
export interface MasterRecord {
  id: string;
  created_at: string;
  is_active: boolean;
}

export interface VatRate extends MasterRecord {
  name: string;
  rate: number;
  surcharge: number;
  is_default: boolean;
}

export interface PaymentMethod extends MasterRecord {
  name: string;
  due_days: number[];
  is_default: boolean;
}

export interface Item extends MasterRecord {
  code: string;
  name: string;
  kind: ItemKind;
  description: string;
  vat_rate_id: string | null;
  base_price: number | null;
  min_stock_kg: number;
}

export interface Silo extends MasterRecord {
  code: string;
  name: string;
  kind: SiloKind;
  capacity_kg: number | null;
}

export interface PriceLine {
  item_id: string;
  price: number;
  item_code: string;
  item_name: string;
}

export interface PriceList extends MasterRecord {
  name: string;
  notes: string;
  lines: PriceLine[];
}

export interface Customer extends MasterRecord {
  code: string;
  name: string;
  tax_id: string | null;
  address: string;
  postal_code: string;
  city: string;
  province: string;
  phone: string;
  email: string;
  sales_rep_id: string | null;
  price_list_id: string | null;
  payment_method_id: string | null;
  credit_limit: number | null;
  /** Recargo de equivalencia en sus facturas (fase 4). */
  equivalence_surcharge: boolean;
  notes: string;
  sales_rep_name: string | null;
  farm_count: number;
  prices: PriceLine[];
}

export interface FarmSilo {
  name: string;
  capacity_kg: number | null;
}

export interface Farm extends MasterRecord {
  customer_id: string;
  customer_name: string;
  name: string;
  rega_code: string;
  address: string;
  postal_code: string;
  city: string;
  province: string;
  latitude: number | null;
  longitude: number | null;
  silos: FarmSilo[];
  notes: string;
}

export interface Carrier extends MasterRecord {
  name: string;
  tax_id: string | null;
  phone: string;
  email: string;
  is_own_fleet: boolean;
}

export interface Truck extends MasterRecord {
  plate: string;
  carrier_id: string | null;
  carrier_name: string | null;
  compartments: number[];
  capacity_kg: number;
  notes: string;
}

export interface Driver extends MasterRecord {
  full_name: string;
  phone: string;
  carrier_id: string | null;
  carrier_name: string | null;
}

export interface LookupOption {
  id: string;
  name: string;
  code?: string | null;
  kind?: string | null;
}

export interface MasterLookups {
  vat_rates: LookupOption[];
  payment_methods: LookupOption[];
  price_lists: LookupOption[];
  carriers: LookupOption[];
  sales_reps: LookupOption[];
  silos: LookupOption[];
  items: LookupOption[];
}

export type LookupKey = keyof MasterLookups;

export interface PriceQuote {
  price: number | null;
  source: PriceSource;
}

// ─── Stock ─────────────────────────────────────────

export interface StockLevel {
  item_id: string;
  item_code: string;
  item_name: string;
  item_kind: ItemKind;
  silo_id: string;
  silo_code: string;
  silo_name: string;
  quantity_kg: number;
}

export interface StockSummaryRow {
  item_id: string;
  item_code: string;
  item_name: string;
  item_kind: ItemKind;
  quantity_kg: number;
  min_stock_kg: number;
  below_min: boolean;
}

export interface StockMovement {
  id: string;
  item_id: string;
  item_code: string;
  item_name: string;
  silo_id: string;
  silo_code: string;
  silo_name: string;
  kind: MovementKind;
  quantity_kg: number;
  lot: string | null;
  occurred_at: string;
  source_type: string | null;
  source_id: string | null;
  notes: string | null;
  user_name: string | null;
}

export interface RawMaterialReceipt {
  id: string;
  number: string;
  item_id: string;
  item_code: string;
  item_name: string;
  silo_id: string;
  silo_code: string;
  silo_name: string;
  supplier: string;
  delivery_note: string;
  plate: string;
  gross_kg: number;
  tare_kg: number;
  net_kg: number;
  received_at: string;
  notes: string;
  user_name: string | null;
}

export interface ReceiptPayload {
  item_id: string;
  silo_id: string;
  supplier: string;
  delivery_note: string;
  plate: string;
  gross_kg: number;
  tare_kg: number;
  received_at?: string;
  notes: string;
}

export interface AdjustmentPayload {
  item_id: string;
  silo_id: string;
  quantity_kg: number;
  reason: string;
}

export interface InventoryLine {
  item_id: string;
  silo_id: string;
  counted_kg: number;
}

export interface InventoryPayload {
  lines: InventoryLine[];
  notes: string;
}

// ─── Fabricación ───────────────────────────────────

export interface ProductionOrder {
  id: string;
  number: string;
  item_id: string;
  item_code: string;
  item_name: string;
  silo_id: string;
  silo_code: string;
  silo_name: string;
  planned_kg: number;
  produced_kg: number | null;
  status: OrderStatus;
  planned_date: string;
  started_at: string | null;
  finished_at: string | null;
  notes: string;
  created_by_name: string | null;
  created_at: string;
}

export interface ProductionOrderPayload {
  item_id: string;
  silo_id: string;
  planned_kg: number;
  planned_date: string;
  notes: string;
}

export interface FinishOrderPayload {
  produced_kg: number;
  silo_id?: string;
}
