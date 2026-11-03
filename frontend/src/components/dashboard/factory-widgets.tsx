"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactNode } from "react";

import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { OrderStatusBadge } from "@/components/factory/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatKg, toIsoDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Page } from "@/types/api";
import type { ProductionOrder, StockLevel, StockSummaryRow } from "@/types/fase1";

import type { WidgetProps } from "./types";

function WidgetCard({ title, href, linkLabel, children }: { title: string; href: string; linkLabel: string; children: ReactNode }) {
  return (
    <Card className="h-full">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        <Link href={href} className="inline-flex min-h-11 items-center text-sm text-link hover:underline">
          {linkLabel}
        </Link>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

interface SiloTotal {
  id: string;
  name: string;
  total: number;
  items: StockLevel[];
}

/** Agrupa los saldos por silo, en el orden en que llegan (la API ordena por silo y artículo). */
export function groupBySilo(levels: StockLevel[]): SiloTotal[] {
  const groups = new Map<string, SiloTotal>();
  for (const level of levels) {
    const group = groups.get(level.silo_id) ?? { id: level.silo_id, name: level.silo_name, total: 0, items: [] };
    group.total += level.quantity_kg;
    group.items.push(level);
    groups.set(level.silo_id, group);
  }
  return [...groups.values()];
}

export function StockBySiloWidget({ size }: WidgetProps) {
  const query = useQuery({
    queryKey: ["stock", "levels", "widget"],
    queryFn: ({ signal }) => api.get<Page<StockLevel>>("/stock/levels", { limit: 200 }, signal),
  });
  return (
    <WidgetCard title="Stock por silo" href="/fabrica/stock" linkLabel="Ver stock">
      {query.isPending ? (
        <LoadingBlock rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title="Silos vacíos" description="Todavía no hay stock en ningún silo." />
      ) : (
        <ul className={cn("grid gap-2", size !== "sm" && "sm:grid-cols-2", size === "lg" && "lg:grid-cols-3")}>
          {groupBySilo(query.data.items).map((silo) => (
            <li key={silo.id} className="rounded-md bg-muted p-3">
              <p className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">{silo.name}</span>
                <span className="shrink-0 text-sm font-bold tabular-nums">{formatKg(silo.total)}</span>
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {silo.items.map((item) => item.item_name).join(", ")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

export function StockShortagesWidget() {
  const query = useQuery({
    queryKey: ["stock", "summary", "widget-below-min"],
    queryFn: ({ signal }) => api.get<Page<StockSummaryRow>>("/stock/summary", { below_min: true, limit: 10 }, signal),
  });
  return (
    <WidgetCard title="Roturas de stock" href="/fabrica/stock" linkLabel="Ver stock">
      {query.isPending ? (
        <LoadingBlock rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title="Todo en orden" description="Ningún artículo está por debajo de su stock mínimo." />
      ) : (
        <>
          <ul className="divide-y">
            {query.data.items.map((row) => (
              <li key={row.item_id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  {row.item_code} · {row.item_name}
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="font-medium text-warning">{formatKg(row.quantity_kg)}</span>
                  <span className="block text-xs text-muted-foreground">mín. {formatKg(row.min_stock_kg)}</span>
                </span>
              </li>
            ))}
          </ul>
          {query.data.total > query.data.items.length ? (
            <p className="mt-2 text-xs text-muted-foreground">Y {query.data.total - query.data.items.length} más.</p>
          ) : null}
        </>
      )}
    </WidgetCard>
  );
}

export function ProductionTodayWidget() {
  const today = toIsoDate();
  const query = useQuery({
    queryKey: ["production", "orders", "widget-today", today],
    queryFn: ({ signal }) =>
      api.get<Page<ProductionOrder>>("/production/orders", { date_from: today, date_to: today, limit: 50 }, signal),
  });
  return (
    <WidgetCard title="Fabricación de hoy" href="/fabrica/fabricacion" linkLabel="Ver órdenes">
      {query.isPending ? (
        <LoadingBlock rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title="Nada previsto para hoy" description="No hay órdenes de fabricación con fecha de hoy." />
      ) : (
        <ul className="divide-y">
          {query.data.items.map((order) => (
            <li key={order.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="block truncate font-medium">{order.item_name}</span>
                <span className="block text-xs text-muted-foreground">
                  {order.number} · {formatKg(order.produced_kg ?? order.planned_kg)}
                </span>
              </span>
              <OrderStatusBadge status={order.status} />
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}
