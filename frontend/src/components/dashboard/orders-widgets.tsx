"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { addDays, ManualPriceFlag, SalesOrderStatusBadge } from "@/components/orders/common";
import { api } from "@/lib/api";
import { formatKg, formatPlainDate, toIsoDate } from "@/lib/format";
import type { Page } from "@/types/api";
import type { OrderDaySummary, SalesOrderSummary } from "@/types/fase2";

import { WidgetCard } from "./factory-widgets";

const WIDGET_LIMIT = 8;

function OrderRows({ orders }: { orders: SalesOrderSummary[] }) {
  return (
    <ul className="divide-y">
      {orders.map((order) => (
        <li key={order.id}>
          <Link href={`/pedidos/${order.id}`} className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm hover:bg-accent/40">
            <span className="min-w-0">
              <span className="block truncate font-medium">{order.customer_name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {order.number} · {formatPlainDate(order.requested_date)} · {formatKg(order.total_kg)}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1">
              <SalesOrderStatusBadge status={order.status} />
              {order.has_manual_price ? <ManualPriceFlag /> : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function MoreNote({ total, shown }: { total: number; shown: number }) {
  return total > shown ? <p className="mt-2 text-xs text-muted-foreground">Y {total - shown} más.</p> : null;
}

/** Borradores, pendientes y rechazados del comercial (lo que tiene «en el aire»). */
export function MyOrdersWidget() {
  const query = useQuery({
    queryKey: ["orders", "widget", "mine"],
    queryFn: ({ signal }) =>
      api.get<Page<SalesOrderSummary>>("/orders", { mine: true, status: "draft,pending,rejected", limit: WIDGET_LIMIT }, signal),
  });
  return (
    <WidgetCard title="Mis pedidos en curso" href="/pedidos" linkLabel="Ver pedidos">
      {query.isPending ? (
        <LoadingBlock rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          title="Nada pendiente"
          description="No tienes borradores, pedidos pendientes ni rechazados."
          action={
            <Link href="/pedidos/nuevo" className="inline-flex min-h-11 items-center text-sm text-link hover:underline">
              Hacer un pedido
            </Link>
          }
        />
      ) : (
        <>
          <OrderRows orders={query.data.items} />
          <MoreNote total={query.data.total} shown={query.data.items.length} />
        </>
      )}
    </WidgetCard>
  );
}

/** Pendientes de validar en oficina. */
export function OrdersToValidateWidget() {
  const query = useQuery({
    queryKey: ["orders", "widget", "pending"],
    queryFn: ({ signal }) => api.get<Page<SalesOrderSummary>>("/orders", { status: "pending", limit: WIDGET_LIMIT }, signal),
  });
  const total = query.data?.total ?? 0;
  return (
    <WidgetCard title={total ? `Pedidos por validar (${total})` : "Pedidos por validar"} href="/pedidos/validar" linkLabel="Ir a la bandeja">
      {query.isPending ? (
        <LoadingBlock rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title="Bandeja vacía" description="No hay pedidos pendientes de validar." />
      ) : (
        <>
          <OrderRows orders={query.data.items} />
          <MoreNote total={query.data.total} shown={query.data.items.length} />
        </>
      )}
    </WidgetCard>
  );
}

const dayFormatter = new Intl.DateTimeFormat("es-ES", { weekday: "short", day: "numeric" });

/** Los 7 días desde hoy, con ceros donde no hay pedidos (la API solo devuelve días con datos). */
export function fillWeek(rows: OrderDaySummary[], from: Date): OrderDaySummary[] {
  const byDate = new Map(rows.map((row) => [row.date.slice(0, 10), row]));
  return Array.from({ length: 7 }, (_, index) => {
    const date = toIsoDate(addDays(from, index));
    return byDate.get(date) ?? { date, orders: 0, total_kg: 0 };
  });
}

/** Kilos y pedidos confirmados por día de entrega, en barras horizontales sencillas. */
export function OrdersWeekWidget() {
  const start = new Date();
  const dateFrom = toIsoDate(start);
  const dateTo = toIsoDate(addDays(start, 6));
  const query = useQuery({
    queryKey: ["orders", "summary", dateFrom, dateTo],
    queryFn: ({ signal }) => api.get<OrderDaySummary[]>("/orders/summary", { date_from: dateFrom, date_to: dateTo }, signal),
  });
  return (
    <WidgetCard title="Pedidos de la semana" href="/pedidos" linkLabel="Ver pedidos">
      {query.isPending ? (
        <LoadingBlock rows={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <WeekBars days={fillWeek(query.data, start)} />
      )}
    </WidgetCard>
  );
}

function WeekBars({ days }: { days: OrderDaySummary[] }) {
  const max = Math.max(...days.map((day) => day.total_kg), 0);
  const totalKg = days.reduce((sum, day) => sum + day.total_kg, 0);
  const totalOrders = days.reduce((sum, day) => sum + day.orders, 0);
  if (totalOrders === 0) {
    return <EmptyState title="Semana tranquila" description="No hay pedidos confirmados para los próximos 7 días." />;
  }
  return (
    <>
      <ul className="space-y-2" aria-label="Kilos confirmados por día de entrega">
        {days.map((day) => {
          const [year, month, dayOfMonth] = day.date.split("-").map(Number);
          const label = dayFormatter.format(new Date(year ?? 0, (month ?? 1) - 1, dayOfMonth ?? 1));
          const width = max > 0 ? Math.max((day.total_kg / max) * 100, day.total_kg > 0 ? 3 : 0) : 0;
          return (
            <li key={day.date} className="grid grid-cols-[4.5rem_1fr] items-center gap-2 text-sm">
              <span className="text-muted-foreground first-letter:uppercase">{label}</span>
              <div className="min-w-0">
                <div className="h-2.5 rounded-full bg-muted" aria-hidden>
                  <div className="h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
                </div>
                <p className="mt-0.5 flex justify-between gap-2 text-xs tabular-nums">
                  <span className="font-medium">{formatKg(day.total_kg)}</span>
                  <span className="text-muted-foreground">
                    {day.orders} {day.orders === 1 ? "pedido" : "pedidos"}
                  </span>
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 border-t pt-2 text-sm">
        <span className="text-muted-foreground">Total 7 días:</span> <span className="font-semibold tabular-nums">{formatKg(totalKg)}</span>{" "}
        <span className="text-muted-foreground">en {totalOrders} {totalOrders === 1 ? "pedido" : "pedidos"}</span>
      </p>
    </>
  );
}
