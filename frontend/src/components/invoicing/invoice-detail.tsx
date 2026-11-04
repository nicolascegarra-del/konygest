"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, FileCheck2, FileMinus, Pencil, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataList, type DataColumn } from "@/components/common/data-list";
import { ErrorState, LoadingBlock } from "@/components/common/states";
import { BackLink, PdfButton } from "@/components/logistics/common";
import { customerHref } from "@/components/masters/definitions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { formatDateTime, formatKg, formatPercent, formatPlainDate, formatPrice } from "@/lib/format";
import { INVOICE_TYPE_LABELS } from "@/lib/labels";
import type { CustomerSnapshot, InvoiceDetail, InvoiceLine } from "@/types/fase4";

import {
  CopyButton,
  invalidateInvoicing,
  invoiceDetailKey,
  invoiceHref,
  InvoiceKindBadge,
  InvoiceLink,
  InvoiceStatusBadge,
  invoiceTitle,
  Money,
  useReadOnly,
} from "./common";
import { CreditNoteDialog } from "./credit-note-dialog";
import { CancelInvoiceDialog, EditInvoiceDialog, IssueDialog } from "./invoice-dialogs";

type DialogName = "edit" | "delete" | "issue" | "credit_note" | "cancel";

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-sm text-muted-foreground sm:w-40">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children || "—"}</dd>
    </div>
  );
}

function text(snapshot: CustomerSnapshot, ...keys: string[]): string {
  for (const key of keys) {
    const value = snapshot[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/** Datos del cliente: los congelados al emitir (`customer_snapshot`) o, en borradores, los actuales. */
function CustomerCard({ invoice }: { invoice: InvoiceDetail }) {
  const snapshot = invoice.status !== "draft" ? invoice.customer_snapshot : null;
  const name = snapshot ? text(snapshot, "legal_name", "name") || invoice.customer_name : invoice.customer_name;
  const address = snapshot
    ? [text(snapshot, "address"), [text(snapshot, "postal_code"), text(snapshot, "city")].filter(Boolean).join(" "), text(snapshot, "province")]
        .filter(Boolean)
        .join(", ")
    : "";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cliente</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-2">
          <InfoRow label="Cliente">
            <Link href={customerHref(invoice.customer_id)} className="text-link hover:underline">
              {invoice.customer_code} · {name}
            </Link>
          </InfoRow>
          {snapshot ? (
            <>
              <InfoRow label="NIF/CIF">{text(snapshot, "tax_id")}</InfoRow>
              <InfoRow label="Dirección">{address}</InfoRow>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Los datos fiscales del cliente se fijan al emitir.</p>
          )}
          <InfoRow label="Forma de pago">{invoice.payment_method_name}</InfoRow>
          {invoice.period_from || invoice.period_to ? (
            <InfoRow label="Periodo">
              {formatPlainDate(invoice.period_from)} – {formatPlainDate(invoice.period_to)}
            </InfoRow>
          ) : null}
          {invoice.notes ? (
            <InfoRow label="Notas">
              <span className="whitespace-pre-line">{invoice.notes}</span>
            </InfoRow>
          ) : null}
        </dl>
      </CardContent>
    </Card>
  );
}

function lineColumns(showCredited: boolean): DataColumn<InvoiceLine>[] {
  return [
    {
      key: "description",
      header: "Concepto",
      render: (line) => (
        <div className="min-w-0">
          <p className="font-medium">{line.description}</p>
          <p className="text-xs text-muted-foreground">
            {line.delivery_note_number ? `Albarán ${line.delivery_note_number}` : null}
            {line.delivery_note_number && line.delivery_date ? " · " : null}
            {line.delivery_date ? formatPlainDate(line.delivery_date) : null}
            {line.order_id && line.order_number ? (
              <>
                {" · "}
                <Link href={`/pedidos/${line.order_id}`} className="text-link hover:underline">
                  {line.order_number}
                </Link>
              </>
            ) : null}
          </p>
        </div>
      ),
    },
    { key: "kg", header: "Kilos", render: (line) => <span className="tabular-nums">{formatKg(line.quantity_kg)}</span> },
    { key: "price", header: "Precio", render: (line) => <span className="tabular-nums">{formatPrice(line.unit_price)}</span> },
    {
      key: "vat",
      header: "IVA",
      render: (line) => (
        <span className="tabular-nums">
          {formatPercent(line.vat_rate)}
          {line.surcharge_rate ? ` + RE ${formatPercent(line.surcharge_rate)}` : ""}
        </span>
      ),
    },
    {
      key: "amount",
      header: "Importe",
      render: (line) => (
        <span className="inline-flex flex-col items-end md:items-start">
          <Money value={line.amount} strong />
          {showCredited && (line.credited_kg || line.credited_amount) ? (
            <span className="text-xs text-muted-foreground">
              Abonado: {formatKg(Math.abs(line.credited_kg))} · <Money value={-Math.abs(line.credited_amount)} />
            </span>
          ) : null}
        </span>
      ),
    },
  ];
}

/** Ficha de una factura o abono: datos, líneas, impuestos, vencimientos, Verifactu y acciones. */
export function InvoiceDetailView({ invoiceId }: { invoiceId: string }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const readOnly = useReadOnly();
  const [dialog, setDialog] = useState<DialogName | null>(null);

  const query = useQuery({
    queryKey: invoiceDetailKey(invoiceId),
    queryFn: ({ signal }) => api.get<InvoiceDetail>(`/invoices/${invoiceId}`, undefined, signal),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/invoices/${invoiceId}`),
    onSuccess: () => {
      toast.success("Borrador borrado. Sus pedidos siguen pendientes de facturar.");
      invalidateInvoicing(queryClient);
      router.push("/facturacion/facturas");
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  if (query.isPending) return <LoadingBlock rows={6} />;
  if (query.isError) {
    return (
      <>
        <BackLink href="/facturacion/facturas" label="Facturas" />
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      </>
    );
  }

  const invoice = query.data;
  const isCredit = invoice.kind === "credit_note";
  const allowed = new Set(readOnly ? [] : invoice.allowed_actions);
  const lines = [...invoice.lines].sort((a, b) => a.position - b.position);
  const canPdf = invoice.status !== "draft";

  return (
    <>
      <BackLink href="/facturacion/facturas" label="Facturas" />
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{invoiceTitle(invoice)}</h1>
            <InvoiceStatusBadge status={invoice.status} />
            <InvoiceKindBadge kind={invoice.kind} type={invoice.invoice_type} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {invoice.customer_code} · {invoice.customer_name} — {formatPlainDate(invoice.issue_date)} ·{" "}
            {INVOICE_TYPE_LABELS[invoice.invoice_type] ?? invoice.invoice_type}
          </p>
        </div>
        {allowed.size > 0 || canPdf ? (
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" aria-label="Acciones de la factura">
            {canPdf ? (
              <PdfButton path={`/invoices/${invoice.id}/pdf`} filename={`${invoice.number ?? "factura"}.pdf`} label="Ver PDF" />
            ) : null}
            {allowed.has("issue") ? (
              <Button onClick={() => setDialog("issue")}>
                <FileCheck2 aria-hidden /> Emitir
              </Button>
            ) : null}
            {allowed.has("edit") ? (
              <Button variant="outline" onClick={() => setDialog("edit")}>
                <Pencil aria-hidden /> Editar
              </Button>
            ) : null}
            {allowed.has("credit_note") ? (
              <Button variant="outline" onClick={() => setDialog("credit_note")}>
                <FileMinus aria-hidden /> Crear abono
              </Button>
            ) : null}
            {allowed.has("cancel") ? (
              <Button variant="ghost" onClick={() => setDialog("cancel")}>
                <Ban aria-hidden /> Anular
              </Button>
            ) : null}
            {allowed.has("delete") ? (
              <Button variant="ghost" onClick={() => setDialog("delete")}>
                <Trash2 aria-hidden /> Borrar
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {invoice.status === "draft" ? (
        <p className="mb-4 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          Borrador: aún no tiene número ni validez fiscal. Los importes se recalculan al emitir.
        </p>
      ) : null}

      {invoice.status === "cancelled" ? (
        <div role="alert" className="mb-4 flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 text-sm">
            <p className="font-semibold">Factura anulada</p>
            {invoice.status_reason ? <p className="mt-1 whitespace-pre-line break-words">{invoice.status_reason}</p> : null}
          </div>
        </div>
      ) : null}

      {isCredit ? (
        <div className="mb-4 rounded-lg border bg-muted/40 p-4 text-sm">
          <p>
            <span className="text-muted-foreground">Rectifica la factura </span>
            {invoice.rectified_invoice_id ? (
              <Link href={invoiceHref(invoice.rectified_invoice_id)} className="font-medium text-link hover:underline">
                {invoice.rectified_number ?? "original"}
              </Link>
            ) : (
              (invoice.rectified_number ?? "—")
            )}
          </p>
          {invoice.rectification_reason ? (
            <p className="mt-1 whitespace-pre-line break-words">
              <span className="text-muted-foreground">Motivo: </span>
              {invoice.rectification_reason}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Líneas</CardTitle>
            </CardHeader>
            <CardContent>
              {lines.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin líneas.</p>
              ) : (
                <DataList rows={lines} columns={lineColumns(!isCredit)} rowKey={(line) => line.id} />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Impuestos y totales</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {invoice.tax_breakdown.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[22rem] text-sm">
                    <caption className="sr-only">Desglose por tipo de IVA</caption>
                    <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th scope="col" className="py-2 text-left font-medium">Tipo</th>
                        <th scope="col" className="py-2 text-right font-medium">Base</th>
                        <th scope="col" className="py-2 text-right font-medium">IVA</th>
                        <th scope="col" className="py-2 text-right font-medium">Recargo</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {invoice.tax_breakdown.map((row) => (
                        <tr key={`${row.vat_rate}-${row.surcharge_rate}`}>
                          <td className="py-2 tabular-nums">
                            {formatPercent(row.vat_rate)}
                            {row.surcharge_rate ? ` + RE ${formatPercent(row.surcharge_rate)}` : ""}
                          </td>
                          <td className="py-2 text-right"><Money value={row.base} /></td>
                          <td className="py-2 text-right"><Money value={row.vat} /></td>
                          <td className="py-2 text-right">{row.surcharge ? <Money value={row.surcharge} /> : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              <dl className="ml-auto max-w-xs space-y-1 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Kilos</dt>
                  <dd className="tabular-nums">{formatKg(invoice.total_kg)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Base imponible</dt>
                  <dd><Money value={invoice.taxable_base} /></dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">IVA</dt>
                  <dd><Money value={invoice.vat_amount} /></dd>
                </div>
                {invoice.surcharge_amount ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Recargo de equivalencia</dt>
                    <dd><Money value={invoice.surcharge_amount} /></dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-4 border-t pt-2 text-base">
                  <dt className="font-semibold">Total</dt>
                  <dd><Money value={invoice.total} strong /></dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {!isCredit && invoice.credit_notes.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Abonos de esta factura</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {invoice.credit_notes.map((note) => (
                    <li key={note.id} className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <InvoiceLink invoice={note} />
                        <InvoiceKindBadge kind={note.kind} type={note.invoice_type} />
                        <InvoiceStatusBadge status={note.status} />
                        <span className="text-muted-foreground">{formatPlainDate(note.issue_date)}</span>
                      </span>
                      <Money value={note.total} strong className="shrink-0" />
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <CustomerCard invoice={invoice} />

          <Card>
            <CardHeader>
              <CardTitle>Vencimientos</CardTitle>
            </CardHeader>
            <CardContent>
              {invoice.due_dates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {invoice.status === "draft" ? "Se calculan al emitir, según la forma de pago del cliente." : "Sin vencimientos."}
                </p>
              ) : (
                <ul className="divide-y text-sm">
                  {invoice.due_dates.map((due, index) => (
                    <li key={`${due.date}-${index}`} className="flex justify-between gap-3 py-2">
                      <span>{formatPlainDate(due.date)}</span>
                      <Money value={due.amount} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {invoice.verifactu ? <VerifactuCard verifactu={invoice.verifactu} /> : null}

          <Card>
            <CardHeader>
              <CardTitle>Historial</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-2 text-sm">
                <li>
                  <span className="text-muted-foreground">Creada</span> el {formatDateTime(invoice.created_at)}
                  {invoice.created_by_name ? ` por ${invoice.created_by_name}` : ""}
                </li>
                {invoice.issued_at ? (
                  <li>
                    <span className="text-muted-foreground">Emitida</span> el {formatDateTime(invoice.issued_at)}
                    {invoice.issued_by_name ? ` por ${invoice.issued_by_name}` : ""}
                  </li>
                ) : null}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>

      {dialog === "issue" ? <IssueDialog invoice={invoice} onClose={() => setDialog(null)} /> : null}
      {dialog === "cancel" ? <CancelInvoiceDialog invoice={invoice} onClose={() => setDialog(null)} /> : null}
      {dialog === "credit_note" ? <CreditNoteDialog invoice={invoice} onClose={() => setDialog(null)} /> : null}
      {dialog === "edit" && !isCredit ? <EditInvoiceDialog invoice={invoice} onClose={() => setDialog(null)} /> : null}
      {dialog === "edit" && isCredit ? <EditCreditNote draft={invoice} onClose={() => setDialog(null)} /> : null}
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={isCredit ? "¿Borrar el borrador de abono?" : "¿Borrar el borrador de factura?"}
        description={
          isCredit
            ? "Se borra el borrador; la factura original no cambia."
            : "Se borra el borrador y sus pedidos vuelven a quedar pendientes de facturar."
        }
        confirmLabel="Borrar borrador"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

/** Para editar un borrador de abono hace falta la factura original (sus líneas y lo ya abonado). */
function EditCreditNote({ draft, onClose }: { draft: InvoiceDetail; onClose: () => void }) {
  const originalId = draft.rectified_invoice_id ?? "";
  const original = useQuery({
    queryKey: invoiceDetailKey(originalId),
    enabled: Boolean(originalId),
    queryFn: ({ signal }) => api.get<InvoiceDetail>(`/invoices/${originalId}`, undefined, signal),
  });
  if (original.data) return <CreditNoteDialog invoice={original.data} draft={draft} onClose={onClose} />;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar el borrador de abono</DialogTitle>
          <DialogDescription>Cargando la factura rectificada…</DialogDescription>
        </DialogHeader>
        {original.isError ? <ErrorState error={original.error} onRetry={() => original.refetch()} /> : <LoadingBlock rows={3} />}
      </DialogContent>
    </Dialog>
  );
}

/** Bloque Verifactu: huella encadenada, fecha de generación y URL de cotejo del QR. */
function VerifactuCard({ verifactu }: { verifactu: NonNullable<InvoiceDetail["verifactu"]> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Verifactu</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Huella</dt>
            <dd className="flex items-center gap-1">
              <code className="min-w-0 break-all font-mono text-xs">{verifactu.hash}</code>
              <CopyButton value={verifactu.hash} label="Copiar la huella" />
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Huella anterior</dt>
            <dd>
              {verifactu.previous_hash ? (
                <code className="break-all font-mono text-xs">{verifactu.previous_hash}</code>
              ) : (
                "Primer registro de la cadena"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Generado</dt>
            <dd>{formatDateTime(verifactu.generated_at)}</dd>
          </div>
          {verifactu.qr_url ? (
            <div>
              <dt className="text-muted-foreground">QR tributario</dt>
              <dd className="flex items-center gap-1">
                <a
                  href={verifactu.qr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center font-medium text-link hover:underline md:min-h-0"
                >
                  Cotejar en la sede de la AEAT
                </a>
                <CopyButton value={verifactu.qr_url} label="Copiar la URL del QR" />
              </dd>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">El envío a la AEAT está pendiente de activar.</p>
        </dl>
      </CardContent>
    </Card>
  );
}
