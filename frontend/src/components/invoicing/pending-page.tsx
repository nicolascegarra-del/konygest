"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarRange, FilePlus2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { EmptyState, ErrorState, Field, LoadingBlock, PageHeader, Pagination } from "@/components/common/states";
import { useCanWrite } from "@/components/factory/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api } from "@/lib/api";
import { friendlyMessage, isApiError } from "@/lib/errors";
import { formatDate, formatKg, formatMoney, formatPlainDate, toIsoDate } from "@/lib/format";
import type { Page } from "@/types/api";
import type {
  BulkInvoicePayload,
  BulkInvoiceResult,
  CreateInvoicePayload,
  InvoiceDetail,
  PendingCustomer,
} from "@/types/fase4";

import { invalidateInvoicing, invoiceHref, Money } from "./common";

const PAGE_SIZE = 20;

/** La fecha de entrega puede llegar como fecha (`YYYY-MM-DD`) o como instante con hora. */
export function formatDelivery(value: string | null | undefined): string {
  if (!value) return "—";
  return value.includes("T") ? formatDate(value) : formatPlainDate(value);
}

/** Pedidos entregados sin factura, agrupados por cliente, para crear borradores de factura. */
export function PendingInvoicingPage() {
  const canIssue = useCanWrite("facturas.emitir");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [bulkOpen, setBulkOpen] = useState(false);
  const debouncedSearch = useDebouncedValue(search.trim());

  const params = { search: debouncedSearch, date_from: dateFrom, date_to: dateTo };
  const query = useQuery({
    queryKey: ["invoicing", "pending", { ...params, offset }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<Page<PendingCustomer>>("/invoicing/pending", { ...params, offset, limit: PAGE_SIZE }, signal),
  });
  const filtered = Boolean(debouncedSearch || dateFrom || dateTo);

  return (
    <>
      <PageHeader
        title="Pendiente de facturar"
        description="Pedidos entregados que aún no tienen factura, agrupados por cliente."
        actions={
          canIssue ? (
            <Button variant="outline" onClick={() => setBulkOpen(true)}>
              <CalendarRange aria-hidden /> Facturar todo el periodo
            </Button>
          ) : undefined
        }
      />

      <div className="mb-4 grid gap-3 md:grid-cols-[1fr_auto_auto]">
        <Input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
          placeholder="Buscar cliente o pedido"
          aria-label="Buscar en lo pendiente de facturar"
        />
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Entregados desde
          <Input
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(event) => {
              setDateFrom(event.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Entregados hasta
          <Input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(event) => {
              setDateTo(event.target.value);
              setOffset(0);
            }}
          />
        </label>
      </div>

      {query.isPending ? (
        <LoadingBlock rows={5} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? "Nada pendiente con estos filtros" : "Todo facturado"}
          description={
            filtered ? "Prueba con otras fechas o con otra búsqueda." : "No hay pedidos entregados pendientes de facturar."
          }
        />
      ) : (
        <>
          <div className="space-y-4">
            {query.data.items.map((customer) => (
              <PendingCustomerCard key={customer.customer_id} customer={customer} canIssue={canIssue} />
            ))}
          </div>
          <Pagination offset={offset} limit={PAGE_SIZE} total={query.data.total} onChange={setOffset} />
        </>
      )}

      {bulkOpen ? <BulkInvoiceDialog onClose={() => setBulkOpen(false)} initialFrom={dateFrom} initialTo={dateTo} /> : null}
    </>
  );
}

/** Tarjeta de un cliente con sus pedidos entregados y la selección para el borrador. */
export function PendingCustomerCard({ customer, canIssue }: { customer: PendingCustomer; canIssue: boolean }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const allSelected = customer.orders.length > 0 && customer.orders.every((order) => selected.has(order.id));
  const chosen = customer.orders.filter((order) => selected.has(order.id));
  const chosenKg = chosen.reduce((sum, order) => sum + order.total_kg, 0);
  const chosenAmount = chosen.reduce((sum, order) => sum + order.amount, 0);

  const create = useMutation({
    mutationFn: (payload: CreateInvoicePayload) => api.post<InvoiceDetail>("/invoices", payload),
    onSuccess: (draft) => {
      toast.success(`Borrador de factura creado para ${customer.customer_name}.`);
      invalidateInvoicing(queryClient);
      router.push(invoiceHref(draft.id));
    },
    onError: (error) => {
      toast.error(friendlyMessage(error));
      if (isApiError(error, "ORDER_NOT_INVOICEABLE")) invalidateInvoicing(queryClient);
    },
  });

  const toggle = (orderId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });

  const headingId = `pending-${customer.customer_id}`;
  return (
    <Card aria-labelledby={headingId}>
      <CardHeader className="gap-1">
        <CardTitle id={headingId} className="text-base">
          {customer.customer_code} · {customer.customer_name}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {customer.order_count} {customer.order_count === 1 ? "pedido" : "pedidos"} · {formatKg(customer.total_kg)} ·{" "}
          base estimada <span className="font-medium text-foreground tabular-nums">{formatMoney(customer.estimated_base)}</span>
          {customer.oldest_delivery ? ` · el más antiguo del ${formatDelivery(customer.oldest_delivery)}` : ""}
        </p>
      </CardHeader>
      <CardContent>
        {canIssue ? (
          <label className="mb-1 flex min-h-11 items-center gap-3 text-sm font-medium">
            <input
              type="checkbox"
              className="size-5 accent-[var(--color-primary)]"
              checked={allSelected}
              onChange={() =>
                setSelected(allSelected ? new Set() : new Set(customer.orders.map((order) => order.id)))
              }
            />
            Seleccionar todos
          </label>
        ) : null}
        <ul className="divide-y rounded-lg border">
          {customer.orders.map((order) => {
            const content = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{order.number}</span>
                  <span className="block text-xs text-muted-foreground">Entregado el {formatDelivery(order.delivered_at)}</span>
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="block">{formatKg(order.total_kg)}</span>
                  <span className="block text-xs text-muted-foreground">{formatMoney(order.amount)}</span>
                </span>
              </>
            );
            return (
              <li key={order.id}>
                {canIssue ? (
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent/40">
                    <input
                      type="checkbox"
                      className="size-5 shrink-0 accent-[var(--color-primary)]"
                      checked={selected.has(order.id)}
                      onChange={() => toggle(order.id)}
                      aria-label={`Incluir el pedido ${order.number}`}
                    />
                    {content}
                  </label>
                ) : (
                  <Link href={`/pedidos/${order.id}`} className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm hover:bg-accent/40">
                    {content}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
        {canIssue ? (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {chosen.length === 0
                ? "Marca los pedidos que quieres incluir en la factura."
                : `${chosen.length} ${chosen.length === 1 ? "pedido" : "pedidos"} · ${formatKg(chosenKg)} · ${formatMoney(chosenAmount)}`}
            </p>
            <Button
              disabled={chosen.length === 0}
              loading={create.isPending}
              onClick={() =>
                create.mutate({ customer_id: customer.customer_id, order_ids: chosen.map((order) => order.id) })
              }
            >
              <FilePlus2 aria-hidden /> Crear borrador
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** «Facturar todo el periodo»: un borrador por cliente con sus pedidos entregados entre dos fechas. */
export function BulkInvoiceDialog({
  onClose,
  initialFrom = "",
  initialTo = "",
}: {
  onClose: () => void;
  initialFrom?: string;
  initialTo?: string;
}) {
  const queryClient = useQueryClient();
  const today = toIsoDate();
  const [dateFrom, setDateFrom] = useState(initialFrom);
  const [dateTo, setDateTo] = useState(initialTo || today);
  const [issueDate, setIssueDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkInvoiceResult | null>(null);

  const bulk = useMutation({
    mutationFn: (payload: BulkInvoicePayload) => api.post<BulkInvoiceResult>("/invoices/bulk", payload),
    onSuccess: (data) => {
      setResult(data);
      invalidateInvoicing(queryClient);
    },
    onError: (failure) => toast.error(friendlyMessage(failure)),
  });

  const confirm = () => {
    if (!dateTo) {
      setError("Indica hasta qué fecha de entrega se factura.");
      return;
    }
    if (dateFrom && dateFrom > dateTo) {
      setError("La fecha «desde» no puede ser posterior a «hasta».");
      return;
    }
    setError(null);
    const payload: BulkInvoicePayload = { date_to: dateTo };
    if (dateFrom) payload.date_from = dateFrom;
    if (issueDate) payload.issue_date = issueDate;
    bulk.mutate(payload);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {result.created.length === 0
                  ? "No se ha creado ningún borrador"
                  : `${result.created.length} ${result.created.length === 1 ? "borrador creado" : "borradores creados"}`}
              </DialogTitle>
              <DialogDescription>
                {result.created.length === 0
                  ? "No había pedidos entregados pendientes de facturar en ese periodo."
                  : "Revísalos y emítelos desde su ficha. Mientras sean borradores se pueden cambiar o borrar."}
              </DialogDescription>
            </DialogHeader>
            {result.created.length > 0 ? (
              <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
                {result.created.map((invoice) => (
                  <li key={invoice.id}>
                    <Link
                      href={invoiceHref(invoice.id)}
                      className="flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-accent/40"
                    >
                      <span className="min-w-0 truncate text-link">
                        {invoice.customer_code} · {invoice.customer_name}
                      </span>
                      <Money value={invoice.total} className="shrink-0" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
            <DialogFooter>
              <Button asChild variant="outline">
                <Link href="/facturacion/facturas">Ver facturas</Link>
              </Button>
              <Button onClick={onClose}>Cerrar</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Facturar todo el periodo</DialogTitle>
              <DialogDescription>
                Se crea un borrador de factura por cliente con todos sus pedidos entregados en el periodo. No se emite
                nada todavía: podrás revisarlos antes.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Entregados desde" htmlFor="bulk-from" hint="Vacío: desde el primero pendiente.">
                <Input id="bulk-from" type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} />
              </Field>
              <Field label="Entregados hasta *" htmlFor="bulk-to" error={error ?? undefined}>
                <Input
                  id="bulk-to"
                  type="date"
                  value={dateTo}
                  min={dateFrom || undefined}
                  aria-invalid={error ? true : undefined}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Fecha de las facturas" htmlFor="bulk-issue" hint="Vacío: la de hoy. Se puede cambiar al emitir.">
                  <Input id="bulk-issue" type="date" value={issueDate} max={today} onChange={(e) => setIssueDate(e.target.value)} />
                </Field>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button loading={bulk.isPending} onClick={confirm}>
                Crear borradores
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
