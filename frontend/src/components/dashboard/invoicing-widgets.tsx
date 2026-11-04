"use client";

import { useQuery } from "@tanstack/react-query";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import Link from "next/link";

import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { isoMonth } from "@/components/invoicing/common";
import { api } from "@/lib/api";
import { formatMoney, formatPercent, formatSignedMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Page } from "@/types/api";
import type { InvoicingMonthSummary, PendingCustomer } from "@/types/fase4";

import { WidgetCard } from "./factory-widgets";

const monthFormatter = new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric" });

/** «noviembre de 2026» a partir de `YYYY-MM`. */
export function monthLabel(month: string): string {
  const [year, value] = month.split("-").map(Number);
  return monthFormatter.format(new Date(year ?? 1970, (value ?? 1) - 1, 1));
}

/** Variación respecto al mes anterior en %, o `null` si el anterior fue 0 (no hay base). */
export function monthChangePct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

/** Neto facturado en el mes (facturas − abonos emitidos), con la comparación con el mes anterior. */
export function InvoicingMonthWidget() {
  const month = isoMonth();
  const query = useQuery({
    queryKey: ["invoicing", "summary", month],
    queryFn: ({ signal }) => api.get<InvoicingMonthSummary>("/invoicing/summary", { month }, signal),
  });
  return (
    <WidgetCard title="Facturación del mes" href="/facturacion/facturas" linkLabel="Ver facturas">
      {query.isPending ? (
        <LoadingBlock rows={2} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <MonthSummary summary={query.data} />
      )}
    </WidgetCard>
  );
}

function MonthSummary({ summary }: { summary: InvoicingMonthSummary }) {
  const diff = summary.net_total - summary.previous_month_net;
  const pct = monthChangePct(summary.net_total, summary.previous_month_net);
  const Icon = diff > 0 ? TrendingUp : diff < 0 ? TrendingDown : Minus;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground first-letter:uppercase">{monthLabel(summary.month)} · neto sin IVA</p>
      <p className="text-3xl font-bold tabular-nums">{formatSignedMoney(summary.net_total)}</p>
      <p className={cn("flex items-center gap-1.5 text-sm", diff > 0 ? "text-success" : diff < 0 ? "text-destructive" : "text-muted-foreground")}>
        <Icon className="size-4 shrink-0" aria-hidden />
        <span>
          {diff === 0 ? "Igual que" : `${formatSignedMoney(diff, { signed: true })}${pct === null ? "" : ` (${pct > 0 ? "+" : pct < 0 ? "−" : ""}${formatPercent(Math.abs(pct))})`} respecto a`}{" "}
          el mes anterior ({formatSignedMoney(summary.previous_month_net)})
        </span>
      </p>
      <dl className="grid grid-cols-3 gap-2 border-t pt-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Facturas</dt>
          <dd className="text-sm font-semibold tabular-nums">{summary.invoice_count}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Facturado</dt>
          <dd className="text-sm tabular-nums">{formatMoney(summary.invoiced_total)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Abonado</dt>
          <dd className="text-sm tabular-nums">{formatSignedMoney(-Math.abs(summary.credit_total))}</dd>
        </div>
      </dl>
    </div>
  );
}

/** Los clientes con más pedidos entregados sin facturar (los 5 primeros). */
export function PendingInvoicingWidget() {
  const query = useQuery({
    queryKey: ["invoicing", "pending", "widget"],
    queryFn: ({ signal }) => api.get<Page<PendingCustomer>>("/invoicing/pending", { limit: 5 }, signal),
  });
  const total = query.data?.total ?? 0;
  return (
    <WidgetCard
      title={total ? `Pendiente de facturar (${total})` : "Pendiente de facturar"}
      href="/facturacion/pendiente"
      linkLabel="Facturar"
    >
      {query.isPending ? (
        <LoadingBlock rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title="Todo facturado" description="No hay pedidos entregados pendientes de facturar." />
      ) : (
        <>
          <ul className="divide-y">
            {query.data.items.map((customer) => (
              <li key={customer.customer_id}>
                <Link href="/facturacion/pendiente" className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm hover:bg-accent/40">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{customer.customer_name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {customer.order_count} {customer.order_count === 1 ? "pedido" : "pedidos"}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{formatMoney(customer.estimated_base)}</span>
                </Link>
              </li>
            ))}
          </ul>
          {total > query.data.items.length ? (
            <p className="mt-2 text-xs text-muted-foreground">Y {total - query.data.items.length} clientes más.</p>
          ) : null}
        </>
      )}
    </WidgetCard>
  );
}
