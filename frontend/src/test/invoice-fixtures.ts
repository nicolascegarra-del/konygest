import type { Me, Scope } from "@/types/api";
import type { InvoiceAction, InvoiceDetail, InvoiceStatus, PendingCustomer } from "@/types/fase4";

/** Usuario de oficina con permisos de facturación. */
export function invoicingMe(options: { readOnly?: boolean; scope?: Scope } = {}): Me {
  const scope = options.scope ?? "all";
  return {
    id: "u-1",
    email: "ofi@example.com",
    full_name: "Oficina",
    tenant: { id: "t-1", name: "Piensos" },
    platform_role: null,
    permissions: { "facturas.ver": scope, "facturas.emitir": scope, "facturas.abonar": scope },
    modules: ["facturacion"],
    support_mode: false,
    read_only: options.readOnly ?? false,
    totp_enabled: false,
    must_setup_2fa: false,
  };
}

export const PENDING: PendingCustomer[] = [
  {
    customer_id: "c-1",
    customer_code: "C01",
    customer_name: "Granja Pérez",
    order_count: 2,
    total_kg: 22000,
    estimated_base: 6480,
    oldest_delivery: "2026-11-02",
    orders: [
      { id: "o-1", number: "PED-2026-0001", delivered_at: "2026-11-02", total_kg: 12000, amount: 3480 },
      { id: "o-2", number: "PED-2026-0002", delivered_at: "2026-11-03", total_kg: 10000, amount: 3000 },
    ],
  },
  {
    customer_id: "c-2",
    customer_code: "C02",
    customer_name: "Ganados López",
    order_count: 1,
    total_kg: 8000,
    estimated_base: 2400,
    oldest_delivery: "2026-11-03",
    orders: [{ id: "o-3", number: "PED-2026-0003", delivered_at: "2026-11-03", total_kg: 8000, amount: 2400 }],
  },
];

/** Factura de ejemplo con dos líneas (la segunda con 1.000 kg ya abonados). */
export function invoice(status: InvoiceStatus, allowed: InvoiceAction[], extra: Partial<InvoiceDetail> = {}): InvoiceDetail {
  const issued = status !== "draft";
  return {
    id: "inv-1",
    kind: "invoice",
    number: issued ? "F-2026-0001" : null,
    invoice_type: "F1",
    status,
    customer_id: "c-1",
    customer_code: "C01",
    customer_name: "Granja Pérez",
    issue_date: "2026-11-04",
    total_kg: 22000,
    taxable_base: 6480,
    vat_amount: 648,
    surcharge_amount: 0,
    total: 7128,
    rectified_invoice_id: null,
    rectified_number: null,
    created_at: "2026-11-04T08:00:00Z",
    issued_at: issued ? "2026-11-04T09:00:00Z" : null,
    notes: "",
    status_reason: "",
    rectification_reason: "",
    period_from: null,
    period_to: null,
    customer_snapshot: issued ? { name: "Granja Pérez SL", tax_id: "B12345678", address: "Camino 1", city: "Lorca" } : null,
    payment_method_name: "30 días",
    due_dates: issued ? [{ date: "2026-12-04", amount: 7128 }] : [],
    tax_breakdown: [{ vat_rate: 10, surcharge_rate: 0, base: 6480, vat: 648, surcharge: 0 }],
    lines: [
      {
        id: "l-1",
        position: 0,
        order_id: "o-1",
        order_number: "PED-2026-0001",
        item_code: "P-CEB",
        description: "Cebo cerdos",
        delivery_note_number: "ALB-2026-0001",
        delivery_date: "2026-11-02",
        quantity_kg: 12000,
        unit_price: 0.29,
        vat_rate: 10,
        surcharge_rate: 0,
        amount: 3480,
        credited_kg: 0,
        credited_amount: 0,
      },
      {
        id: "l-2",
        position: 1,
        order_id: "o-2",
        order_number: "PED-2026-0002",
        item_code: "P-LEC",
        description: "Lechones",
        delivery_note_number: "ALB-2026-0002",
        delivery_date: "2026-11-03",
        quantity_kg: 10000,
        unit_price: 0.3,
        vat_rate: 10,
        surcharge_rate: 0,
        amount: 3000,
        credited_kg: 1000,
        credited_amount: 300,
      },
    ],
    credit_notes: [],
    verifactu: issued
      ? {
          hash: "A".repeat(64),
          previous_hash: null,
          generated_at: "2026-11-04T09:00:00Z",
          qr_url: "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=B1&numserie=F-2026-0001",
        }
      : null,
    pdf_ready: issued,
    issued_by_name: issued ? "Oficina" : null,
    created_by_name: "Oficina",
    allowed_actions: allowed,
    ...extra,
  };
}
