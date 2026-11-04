"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { ErrorState, Field, LoadingBlock } from "@/components/common/states";
import { customerHref } from "@/components/masters/definitions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { api } from "@/lib/api";
import { ApiError, friendlyMessage, isApiError } from "@/lib/errors";
import { formatKg, formatMoney, toIsoDate } from "@/lib/format";
import type { Page } from "@/types/api";
import type { InvoiceDetail, IssuePayload, PendingCustomer, UpdateInvoicePayload } from "@/types/fase4";

import { invalidateInvoicing, invoiceTitle, REASON_MAX, reasonError } from "./common";
import { formatDelivery } from "./pending-page";

/** Nombre legible de los campos fiscales de la empresa que puede señalar `COMPANY_FISCAL_DATA_MISSING`. */
const COMPANY_FIELD_LABELS: Record<string, string> = {
  tax_id: "el NIF",
  address: "la dirección",
  postal_code: "el código postal",
  city: "la población",
  province: "la provincia",
  legal_name: "la razón social",
};

/** Errores de emisión que se explican dentro del diálogo, con enlace para resolverlos. */
const INLINE_ISSUE_ERRORS = new Set([
  "COMPANY_FISCAL_DATA_MISSING",
  "CUSTOMER_TAX_ID_MISSING",
  "ISSUE_DATE_OUT_OF_ORDER",
  "EMPTY_INVOICE",
  "VAT_NOT_CONFIGURED",
  "INVALID_STATUS",
]);

/** Explicación de un error de emisión con el enlace a donde se arregla. */
export function IssueErrorNotice({ error, customerId }: { error: ApiError; customerId: string }) {
  let detail: string | null = null;
  let link: { href: string; label: string } | null = null;
  if (error.code === "COMPANY_FISCAL_DATA_MISSING") {
    const field = error.field ? COMPANY_FIELD_LABELS[error.field] : undefined;
    if (field) detail = `Falta ${field} de la empresa.`;
    link = { href: "/ajustes/empresa", label: "Completar en Ajustes → Empresa" };
  } else if (error.code === "CUSTOMER_TAX_ID_MISSING") {
    link = { href: customerHref(customerId), label: "Abrir la ficha del cliente" };
  } else if (error.code === "VAT_NOT_CONFIGURED") {
    link = { href: "/maestros/iva", label: "Ir a Tipos de IVA" };
  }
  return (
    <div role="alert" className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">{friendlyMessage(error)}</p>
        {detail ? <p className="text-muted-foreground">{detail}</p> : null}
        {link ? (
          <Link href={link.href} className="mt-1 inline-flex min-h-11 items-center font-medium text-link hover:underline md:min-h-0">
            {link.label}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** Confirmación de la emisión: fecha de expedición y aviso de que ya no se podrá modificar. */
export function IssueDialog({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const today = toIsoDate();
  const [issueDate, setIssueDate] = useState(invoice.issue_date > today ? today : invoice.issue_date);
  const [error, setError] = useState<ApiError | null>(null);
  const isCredit = invoice.kind === "credit_note";

  const issue = useMutation({
    mutationFn: (payload: IssuePayload) => api.post<InvoiceDetail>(`/invoices/${invoice.id}/issue`, payload),
    onSuccess: (issued) => {
      const number = issued.number ?? "";
      toast.success(
        isCredit
          ? `Abono ${number} emitido y registrado en Verifactu.`
          : `Factura ${number} emitida y registrada en Verifactu.`,
      );
      invalidateInvoicing(queryClient);
      onClose();
    },
    onError: (failure) => {
      if (isApiError(failure) && INLINE_ISSUE_ERRORS.has(failure.code)) {
        setError(failure);
        if (failure.code === "INVALID_STATUS") invalidateInvoicing(queryClient);
        return;
      }
      toast.error(friendlyMessage(failure));
    },
  });

  const confirm = () => {
    setError(null);
    issue.mutate(issueDate && issueDate !== invoice.issue_date ? { issue_date: issueDate } : {});
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isCredit ? "Emitir el abono" : "Emitir la factura"}</DialogTitle>
          <DialogDescription>
            Se le asigna número y se genera el PDF para {invoice.customer_name}.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p>
            <span className="font-medium">
              Una vez emitid{isCredit ? "o" : "a"} no se puede modificar; se registra en Verifactu.
            </span>{" "}
            Para corregirl{isCredit ? "o" : "a"} después habrá que hacer un abono.
          </p>
        </div>
        <Field label="Fecha de expedición" htmlFor="issue-date" hint="No puede ser futura ni anterior a la última emitida.">
          <Input id="issue-date" type="date" value={issueDate} max={today} onChange={(event) => setIssueDate(event.target.value)} />
        </Field>
        {error ? <IssueErrorNotice error={error} customerId={invoice.customer_id} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Volver
          </Button>
          <Button loading={issue.isPending} onClick={confirm}>
            {isCredit ? "Emitir abono" : "Emitir factura"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Anular una factura emitida por error (con motivo). */
export function CancelInvoiceDialog({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);

  const cancel = useMutation({
    mutationFn: (payload: { reason: string }) => api.post<InvoiceDetail>(`/invoices/${invoice.id}/cancel`, payload),
    onSuccess: () => {
      toast.success(`${invoiceTitle(invoice)} anulada. Sus pedidos vuelven a estar pendientes de facturar.`);      invalidateInvoicing(queryClient);
      onClose();
    },
    onError: (failure) => {
      if (isApiError(failure, "HAS_CREDIT_NOTES")) {
        setBlocked(friendlyMessage(failure));
        return;
      }
      if (isApiError(failure) && failure.field === "reason") setError(friendlyMessage(failure));
      toast.error(friendlyMessage(failure));
    },
  });

  const confirm = () => {
    const problem = reasonError(reason);
    setError(problem);
    if (!problem) cancel.mutate({ reason: reason.trim() });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Anular la factura {invoice.number}</DialogTitle>
          <DialogDescription>
            Solo para facturas emitidas por error (cliente equivocado, factura duplicada…). Queda anulada, se genera un
            registro de anulación en Verifactu y sus pedidos vuelven a «Entregado» para facturarlos de nuevo. Si lo que
            hay que corregir son kilos o precios, crea un abono.
          </DialogDescription>
        </DialogHeader>
        <Field label="Motivo *" htmlFor="cancel-reason" error={error ?? undefined} hint={`Máximo ${REASON_MAX} caracteres.`}>
          <Textarea
            id="cancel-reason"
            value={reason}
            maxLength={REASON_MAX + 50}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setReason(event.target.value);
              if (error) setError(reasonError(event.target.value));
            }}
          />
        </Field>
        {blocked ? (
          <div role="alert" className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <p>{blocked}</p>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Volver
          </Button>
          <Button variant="destructive" loading={cancel.isPending} disabled={Boolean(blocked)} onClick={confirm}>
            Anular factura
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CandidateOrder {
  id: string;
  number: string;
  delivered_at: string | null;
  total_kg: number;
  amount: number;
}

/** Pedidos que ya están en el borrador, sacados de sus líneas (un pedido puede tener varias). */
export function ordersInInvoice(invoice: InvoiceDetail): CandidateOrder[] {
  const byId = new Map<string, CandidateOrder>();
  for (const line of invoice.lines) {
    if (!line.order_id) continue;
    const current = byId.get(line.order_id) ?? {
      id: line.order_id,
      number: line.order_number ?? "Pedido",
      delivered_at: line.delivery_date,
      total_kg: 0,
      amount: 0,
    };
    current.total_kg += line.quantity_kg;
    current.amount += line.amount;
    byId.set(line.order_id, current);
  }
  return [...byId.values()];
}

/** Editar un borrador de factura: pedidos incluidos, fecha y notas (las líneas se recalculan). */
export function EditInvoiceDialog({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const included = ordersInInvoice(invoice);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(included.map((order) => order.id)));
  const [issueDate, setIssueDate] = useState(invoice.issue_date);
  const [notes, setNotes] = useState(invoice.notes);
  const [error, setError] = useState<string | null>(null);

  const pending = useQuery({
    queryKey: ["invoicing", "pending", { customer_id: invoice.customer_id }],
    queryFn: ({ signal }) =>
      api.get<Page<PendingCustomer>>("/invoicing/pending", { customer_id: invoice.customer_id, limit: 1 }, signal),
  });

  const save = useMutation({
    mutationFn: (payload: UpdateInvoicePayload) => api.put<InvoiceDetail>(`/invoices/${invoice.id}`, payload),
    onSuccess: () => {
      toast.success("Borrador actualizado.");
      invalidateInvoicing(queryClient);
      onClose();
    },
    onError: (failure) => {
      toast.error(friendlyMessage(failure));
      if (isApiError(failure, "ORDER_NOT_INVOICEABLE")) invalidateInvoicing(queryClient);
    },
  });

  const extra = (pending.data?.items.find((row) => row.customer_id === invoice.customer_id)?.orders ?? []).filter(
    (order) => !included.some((current) => current.id === order.id),
  );
  const candidates: CandidateOrder[] = [...included, ...extra];

  const toggle = (orderId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });

  const confirm = () => {
    if (selected.size === 0) {
      setError("Deja al menos un pedido en la factura (o borra el borrador).");
      return;
    }
    setError(null);
    const payload: UpdateInvoicePayload = { order_ids: candidates.filter((o) => selected.has(o.id)).map((o) => o.id), notes: notes.trim() };
    if (issueDate) payload.issue_date = issueDate;
    save.mutate(payload);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Editar el borrador</DialogTitle>
          <DialogDescription>
            Elige los pedidos entregados de {invoice.customer_name} que entran en la factura. Las líneas se recalculan al
            guardar.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-1">
          <legend className="mb-1 text-sm font-medium">Pedidos</legend>
          <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
            {candidates.map((order) => (
              <li key={order.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent/40">
                  <input
                    type="checkbox"
                    className="size-5 shrink-0 accent-[var(--color-primary)]"
                    checked={selected.has(order.id)}
                    onChange={() => toggle(order.id)}
                    aria-label={`Incluir el pedido ${order.number}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{order.number}</span>
                    <span className="block text-xs text-muted-foreground">Entregado el {formatDelivery(order.delivered_at)}</span>
                  </span>
                  <span className="shrink-0 text-right tabular-nums">
                    <span className="block">{formatKg(order.total_kg)}</span>
                    <span className="block text-xs text-muted-foreground">{formatMoney(order.amount)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {pending.isPending ? <LoadingBlock rows={1} /> : null}
          {pending.isError ? <ErrorState error={pending.error} onRetry={() => pending.refetch()} /> : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </fieldset>
        <Field label="Fecha de la factura" htmlFor="edit-issue-date" hint="Se puede cambiar también al emitir.">
          <Input id="edit-issue-date" type="date" value={issueDate} max={toIsoDate()} onChange={(event) => setIssueDate(event.target.value)} />
        </Field>
        <Field label="Notas" htmlFor="edit-notes" hint="Salen en la factura.">
          <Textarea id="edit-notes" className="min-h-20" maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} onClick={confirm}>
            Guardar borrador
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
