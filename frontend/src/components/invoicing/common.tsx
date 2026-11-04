"use client";

import type { QueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatSignedMoney } from "@/lib/format";
import { INVOICE_KIND_LABELS, INVOICE_STATUS_LABELS, INVOICE_STATUS_VARIANTS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import type { InvoiceKind, InvoiceStatus, InvoiceSummary } from "@/types/fase4";

/** Prefijo de las consultas de facturas (listados y fichas). */
export const INVOICES_KEY = ["invoices"] as const;
/** Prefijo de las consultas de facturación (pendiente de facturar y resumen del mes). */
export const INVOICING_KEY = ["invoicing"] as const;
/** Prefijo de las consultas del registro Verifactu. */
export const VERIFACTU_KEY = ["verifactu"] as const;

export function invoiceDetailKey(invoiceId: string) {
  return ["invoices", "detail", invoiceId] as const;
}

/**
 * Tras cualquier cambio en una factura cambian listados, fichas, el pendiente de facturar,
 * los pedidos (pasan a «Facturado» o vuelven a «Entregado») y el registro Verifactu.
 */
export function invalidateInvoicing(queryClient: QueryClient) {
  for (const key of [INVOICES_KEY, INVOICING_KEY, ["orders"], VERIFACTU_KEY]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

export const invoiceHref = (id: string) => `/facturacion/facturas/${id}`;

/** ¿Está la cuenta en solo lectura? (entonces no se muestra ninguna acción que escriba). */
export function useReadOnly(): boolean {
  return useAuthStore((state) => state.user?.read_only ?? false);
}

/** Número de la factura o «Borrador» si aún no se ha emitido. */
export function invoiceNumber(invoice: Pick<InvoiceSummary, "number">): string {
  return invoice.number ?? "Borrador";
}

/** «Factura F-2026-0001», «Abono R-2026-0002», «Borrador de factura». */
export function invoiceTitle(invoice: Pick<InvoiceSummary, "number" | "kind">): string {
  if (!invoice.number) return invoice.kind === "credit_note" ? "Borrador de abono" : "Borrador de factura";
  return `${INVOICE_KIND_LABELS[invoice.kind]} ${invoice.number}`;
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return <Badge variant={INVOICE_STATUS_VARIANTS[status]}>{INVOICE_STATUS_LABELS[status]}</Badge>;
}

export function InvoiceKindBadge({ kind, type }: { kind: InvoiceKind; type: string }) {
  return (
    <Badge variant={kind === "credit_note" ? "warning" : "secondary"} title={INVOICE_KIND_LABELS[kind]}>
      {type}
    </Badge>
  );
}

/** Importe con signo; los negativos (abonos) en color de aviso además del signo «−». */
export function Money({ value, className, strong = false }: { value: number; className?: string; strong?: boolean }) {
  return (
    <span className={cn("tabular-nums", strong && "font-semibold", value < 0 && "text-destructive", className)}>
      {formatSignedMoney(value)}
    </span>
  );
}

export function InvoiceLink({ invoice }: { invoice: Pick<InvoiceSummary, "id" | "number" | "kind"> }) {
  return (
    <Link href={invoiceHref(invoice.id)} className="text-link hover:underline">
      {invoice.number ?? (invoice.kind === "credit_note" ? "Borrador de abono" : "Borrador")}
    </Link>
  );
}

export const REASON_MAX = 500;

/** Valida un motivo obligatorio (1–500 caracteres). */
export function reasonError(reason: string): string | null {
  const text = reason.trim();
  if (!text) return "Indica el motivo.";
  if (text.length > REASON_MAX) return `Como máximo ${REASON_MAX} caracteres.`;
  return null;
}

/** Redondeo a céntimos como el backend. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Mes de `date` (por defecto, hoy) como `YYYY-MM`. */
export function isoMonth(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Huella abreviada para listados: «a1b2c3d4…e5f6». */
export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

/** Botón de copiar al portapapeles (huellas, URL del QR). */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
          toast.success("Copiado.");
        } catch {
          toast.error("No se ha podido copiar.");
        }
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </Button>
  );
}
