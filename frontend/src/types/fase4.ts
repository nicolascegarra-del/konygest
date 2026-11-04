/** Tipos del contrato de la fase 4: facturación, abonos y registro Verifactu (docs/api-fase4.md). */

export type InvoiceKind = "invoice" | "credit_note";
export type InvoiceStatus = "draft" | "issued" | "cancelled";
/** Tipo Verifactu: F1 factura completa; R1..R5 rectificativas (el frontend solo crea R1 y R4). */
export type InvoiceType = "F1" | "F2" | "R1" | "R2" | "R3" | "R4" | "R5";
export type CreditNoteType = "R1" | "R4";

/** Acciones que el usuario actual puede hacer ya sobre la factura (`allowed_actions`). */
export type InvoiceAction = "edit" | "delete" | "issue" | "credit_note" | "cancel";

export interface PendingOrder {
  id: string;
  number: string;
  delivered_at: string | null;
  total_kg: number;
  amount: number;
}

/** Cliente con pedidos entregados sin factura (`GET /invoicing/pending`). */
export interface PendingCustomer {
  customer_id: string;
  customer_code: string;
  customer_name: string;
  order_count: number;
  total_kg: number;
  estimated_base: number;
  oldest_delivery: string | null;
  orders: PendingOrder[];
}

export interface InvoiceSummary {
  id: string;
  kind: InvoiceKind;
  /** `null` en los borradores: el número se asigna al emitir. */
  number: string | null;
  invoice_type: InvoiceType;
  status: InvoiceStatus;
  customer_id: string;
  customer_code: string;
  customer_name: string;
  issue_date: string;
  total_kg: number;
  taxable_base: number;
  vat_amount: number;
  surcharge_amount: number;
  /** Con signo: los abonos van en negativo. */
  total: number;
  rectified_invoice_id: string | null;
  rectified_number: string | null;
  created_at: string;
  issued_at: string | null;
}

export interface InvoiceDueDate {
  date: string;
  amount: number;
}

export interface InvoiceTaxBreakdown {
  vat_rate: number;
  surcharge_rate: number;
  base: number;
  vat: number;
  surcharge: number;
}

export interface InvoiceLine {
  id: string;
  position: number;
  order_id: string | null;
  order_number: string | null;
  item_code: string;
  description: string;
  delivery_note_number: string | null;
  delivery_date: string | null;
  quantity_kg: number;
  unit_price: number;
  vat_rate: number;
  surcharge_rate: number;
  amount: number;
  /** Lo ya abonado de esta línea en abonos emitidos. */
  credited_kg: number;
  credited_amount: number;
}

/** Datos del cliente congelados al emitir. El contrato no fija sus claves: se leen con cuidado. */
export type CustomerSnapshot = Record<string, unknown>;

export interface InvoiceVerifactu {
  hash: string;
  previous_hash: string | null;
  generated_at: string;
  qr_url: string | null;
}

export interface InvoiceDetail extends InvoiceSummary {
  notes: string;
  /** Motivo de la anulación. */
  status_reason: string;
  rectification_reason: string;
  period_from: string | null;
  period_to: string | null;
  customer_snapshot: CustomerSnapshot | null;
  payment_method_name: string;
  due_dates: InvoiceDueDate[];
  tax_breakdown: InvoiceTaxBreakdown[];
  lines: InvoiceLine[];
  credit_notes: InvoiceSummary[];
  verifactu: InvoiceVerifactu | null;
  pdf_ready: boolean;
  issued_by_name: string | null;
  created_by_name: string | null;
  allowed_actions: InvoiceAction[];
}

export interface CreateInvoicePayload {
  customer_id: string;
  order_ids: string[];
  issue_date?: string;
  notes?: string;
}

export interface BulkInvoicePayload {
  date_from?: string;
  date_to: string;
  customer_ids?: string[];
  issue_date?: string;
}

export interface BulkInvoiceResult {
  created: InvoiceSummary[];
}

export interface UpdateInvoicePayload {
  order_ids: string[];
  issue_date?: string;
  notes?: string;
}

/** Línea de abono: kg devueltos (al mismo precio) **o** descuento en €. */
export interface CreditLinePayload {
  invoice_line_id: string;
  quantity_kg?: number;
  amount?: number;
}

export interface CreditNotePayload {
  invoice_type?: CreditNoteType;
  rectification_reason: string;
  full?: boolean;
  lines?: CreditLinePayload[];
}

export interface UpdateCreditNotePayload {
  lines: CreditLinePayload[];
  rectification_reason: string;
  invoice_type: CreditNoteType;
  issue_date?: string;
  notes?: string;
}

export interface IssuePayload {
  issue_date?: string;
}

export type VerifactuRecordType = "alta" | "anulacion";

export interface VerifactuRecord {
  id: string;
  sequence: number;
  record_type: VerifactuRecordType;
  invoice_id: string;
  invoice_number: string;
  issue_date: string;
  invoice_type: string;
  total_tax: number | null;
  total_amount: number | null;
  generated_at: string;
  previous_hash: string | null;
  hash: string;
  send_status: string;
}

export interface VerifactuVerifyResult {
  ok: boolean;
  records: number;
  broken: { sequence: number; invoice_number: string }[];
}

export interface InvoicingMonthSummary {
  month: string;
  invoiced_total: number;
  credit_total: number;
  net_total: number;
  invoice_count: number;
  previous_month_net: number;
}
