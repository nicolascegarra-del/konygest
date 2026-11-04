"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { LoadStatusBadge, OccupancyBar, plural } from "@/components/logistics/common";
import { api } from "@/lib/api";
import { formatKg, toIsoDate } from "@/lib/format";
import type { Page } from "@/types/api";
import type { LoadSummary } from "@/types/fase3";

import { WidgetCard } from "./factory-widgets";

const WIDGET_LIMIT = 8;

function MoreNote({ total, shown }: { total: number; shown: number }) {
  return total > shown ? <p className="mt-2 text-xs text-muted-foreground">Y {total - shown} más.</p> : null;
}

/** Camiones planificados para hoy, con ocupación y estado. */
export function LoadsTodayWidget() {
  const today = toIsoDate();
  const query = useQuery({
    queryKey: ["loads", "widget", "today", today],
    queryFn: ({ signal }) => api.get<Page<LoadSummary>>("/loads", { date: today, limit: WIDGET_LIMIT }, signal),
  });
  return (
    <WidgetCard title="Cargas de hoy" href="/logistica" linkLabel="Ir a planificación">
      {query.isPending ? (
        <LoadingBlock rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title="Sin cargas hoy" description="No hay camiones planificados para hoy." />
      ) : (
        <>
          <ul className="divide-y">
            {query.data.items.map((load) => (
              <li key={load.id}>
                <Link href={`/logistica/cargas/${load.id}`} className="block min-h-11 py-2 text-sm hover:bg-accent/40">
                  <span className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium">
                      {load.truck_plate} <span className="font-normal text-muted-foreground">· {load.number}</span>
                    </span>
                    <LoadStatusBadge status={load.status} />
                  </span>
                  <OccupancyBar className="mt-1" plannedKg={load.planned_kg} capacityKg={load.capacity_kg} />
                </Link>
              </li>
            ))}
          </ul>
          <MoreNote total={query.data.total} shown={query.data.items.length} />
        </>
      )}
    </WidgetCard>
  );
}

/** Órdenes de carga emitidas que fábrica aún no ha pesado. */
export function LoadsToWeighWidget() {
  const query = useQuery({
    queryKey: ["loads", "widget", "ready"],
    queryFn: ({ signal }) => api.get<Page<LoadSummary>>("/loads", { status: "ready", limit: WIDGET_LIMIT }, signal),
  });
  const total = query.data?.total ?? 0;
  return (
    <WidgetCard title={total ? `Cargas por cargar (${total})` : "Cargas por cargar"} href="/fabrica/cargas" linkLabel="Ver todas">
      {query.isPending ? (
        <LoadingBlock rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title="Nada por cargar" description="No hay órdenes de carga pendientes de pesar." />
      ) : (
        <>
          <ul className="divide-y">
            {query.data.items.map((load) => (
              <li key={load.id}>
                <Link href={`/fabrica/cargas/${load.id}`} className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm hover:bg-accent/40">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{load.truck_plate}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {load.number} · {plural(load.stop_count, "parada", "paradas")}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{formatKg(load.planned_kg)}</span>
                </Link>
              </li>
            ))}
          </ul>
          <MoreNote total={query.data.total} shown={query.data.items.length} />
        </>
      )}
    </WidgetCard>
  );
}
