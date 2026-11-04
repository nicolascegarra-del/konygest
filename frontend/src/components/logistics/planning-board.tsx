"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, TriangleAlert, Truck as TruckIcon, User } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/common/states";
import { Tabs, useCanWrite } from "@/components/factory/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatKg, formatPlainDate, toIsoDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Page } from "@/types/api";
import type { LoadSummary, PendingOrder } from "@/types/fase3";

import { LoadStatusBadge, longDay, OccupancyBar, plural, shiftIsoDate } from "./common";

const PENDING_LIMIT = 100;

/** Enlace a «Nueva carga» con el día y los pedidos elegidos ya puestos. */
export function newLoadHref(day: string, orderIds: string[] = []): string {
  const params = new URLSearchParams({ date: day });
  if (orderIds.length) params.set("orders", orderIds.join(","));
  return `/logistica/cargas/nueva?${params.toString()}`;
}

/** Tablero de planificación de un día: pedidos pendientes a la izquierda y cargas del día a la derecha. */
export function PlanningBoard() {
  const today = toIsoDate();
  const [day, setDay] = useState(today);
  const [tab, setTab] = useState<"pending" | "loads">("pending");
  const [selected, setSelected] = useState<string[]>([]);
  const canPlan = useCanWrite("logistica.planificar");

  const pending = useQuery({
    queryKey: ["logistics", "pending", { date_to: day }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<Page<PendingOrder>>("/logistics/pending-orders", { date_to: day, limit: PENDING_LIMIT }, signal),
  });
  const loads = useQuery({
    queryKey: ["loads", "list", { date: day }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => api.get<Page<LoadSummary>>("/loads", { date: day, limit: 50 }, signal),
  });

  const changeDay = (next: string) => {
    if (!next) return;
    setDay(next);
    setSelected([]);
  };
  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));

  const pendingCount = pending.data?.total ?? 0;
  const loadCount = loads.data?.total ?? 0;
  const selectedKg = (pending.data?.items ?? [])
    .filter((order) => selected.includes(order.id))
    .reduce((sum, order) => sum + order.total_kg, 0);

  return (
    <>
      <PageHeader
        title="Planificación"
        description="Reparte los pedidos confirmados en las cargas de cada día."
        actions={
          canPlan ? (
            <Button asChild>
              <Link href={newLoadHref(day)}>
                <Plus aria-hidden /> Nueva carga
              </Link>
            </Button>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Día anterior" onClick={() => changeDay(shiftIsoDate(day, -1))}>
          <ChevronLeft aria-hidden />
        </Button>
        <Input
          type="date"
          aria-label="Día"
          value={day}
          onChange={(event) => changeDay(event.target.value)}
          className="w-auto min-w-0 flex-1 sm:flex-none"
        />
        <Button variant="outline" size="icon" aria-label="Día siguiente" onClick={() => changeDay(shiftIsoDate(day, 1))}>
          <ChevronRight aria-hidden />
        </Button>
        {day !== today ? (
          <Button variant="ghost" onClick={() => changeDay(today)}>
            Hoy
          </Button>
        ) : null}
        <p className="w-full text-sm text-muted-foreground sm:w-auto sm:pl-2">{longDay(day)}</p>
      </div>

      <div className="lg:hidden">
        <Tabs
          label="Vista del tablero"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "pending", label: `Por planificar${pending.data ? ` (${pendingCount})` : ""}` },
            { value: "loads", label: `Cargas${loads.data ? ` (${loadCount})` : ""}` },
          ]}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="pending-title" className={cn(tab !== "pending" && "hidden", "lg:block")}>
          <Card>
            <CardHeader>
              <CardTitle id="pending-title">Pedidos por planificar{pending.data ? ` (${pendingCount})` : ""}</CardTitle>
              <p className="text-sm text-muted-foreground">Confirmados sin carga con entrega hasta este día.</p>
            </CardHeader>
            <CardContent>
              {pending.isPending ? (
                <LoadingBlock rows={4} />
              ) : pending.isError ? (
                <ErrorState error={pending.error} onRetry={() => pending.refetch()} />
              ) : pending.data.items.length === 0 ? (
                <EmptyState title="Todo planificado" description="No quedan pedidos confirmados sin carga hasta este día." />
              ) : (
                <>
                  <ul className="space-y-2">
                    {pending.data.items.map((order) => (
                      <PendingOrderCard
                        key={order.id}
                        order={order}
                        day={day}
                        selectable={canPlan}
                        selected={selected.includes(order.id)}
                        onToggle={() => toggle(order.id)}
                      />
                    ))}
                  </ul>
                  {pending.data.total > pending.data.items.length ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Se muestran {pending.data.items.length} de {pending.data.total}.
                    </p>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        </section>

        <section aria-labelledby="loads-title" className={cn(tab !== "loads" && "hidden", "lg:block")}>
          <Card>
            <CardHeader>
              <CardTitle id="loads-title">Cargas del día{loads.data ? ` (${loadCount})` : ""}</CardTitle>
            </CardHeader>
            <CardContent>
              {loads.isPending ? (
                <LoadingBlock rows={3} />
              ) : loads.isError ? (
                <ErrorState error={loads.error} onRetry={() => loads.refetch()} />
              ) : loads.data.items.length === 0 ? (
                <EmptyState
                  title="Sin cargas este día"
                  description="Crea una carga y añade los pedidos que van en el camión."
                  action={
                    canPlan ? (
                      <Button variant="outline" asChild>
                        <Link href={newLoadHref(day)}>
                          <Plus aria-hidden /> Nueva carga
                        </Link>
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <ul className="space-y-3">
                  {loads.data.items.map((load) => (
                    <LoadCard key={load.id} load={load} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>
      </div>

      {selected.length > 0 ? (
        <div className="sticky bottom-3 z-20 mt-4 flex flex-col gap-2 rounded-lg border bg-card p-3 shadow-md sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">
            <span className="font-medium">{plural(selected.length, "pedido elegido", "pedidos elegidos")}</span>
            <span className="text-muted-foreground"> · {formatKg(selectedKg)}</span>
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setSelected([])}>
              Quitar selección
            </Button>
            <Button asChild>
              <Link href={newLoadHref(day, selected)}>
                <TruckIcon aria-hidden /> Añadir a una carga nueva
              </Link>
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function PendingOrderCard({
  order,
  day,
  selectable,
  selected,
  onToggle,
}: {
  order: PendingOrder;
  day: string;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const late = order.requested_date.slice(0, 10) < day;
  const checkboxId = `pending-${order.id}`;
  return (
    <li
      className={cn(
        "flex gap-3 rounded-lg border p-3",
        late && "border-warning/60 bg-warning/5",
        selected && "border-primary ring-1 ring-primary",
      )}
    >
      {selectable ? (
        <div className="flex min-h-11 min-w-11 items-start justify-center pt-0.5">
          <input
            id={checkboxId}
            type="checkbox"
            className="size-5 accent-[var(--color-primary)]"
            checked={selected}
            onChange={onToggle}
            aria-label={`Elegir ${order.number} (${order.customer_name})`}
          />
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 truncate font-medium">{order.customer_name}</p>
          <span className="shrink-0 text-sm font-semibold tabular-nums">{formatKg(order.total_kg)}</span>
        </div>
        <p className="truncate text-sm text-muted-foreground">
          {order.farm_name}
          {order.farm_city ? ` · ${order.farm_city}` : ""}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <Link href={`/pedidos/${order.id}`} className="inline-flex min-h-11 items-center text-link hover:underline md:min-h-0">
            {order.number}
          </Link>
          <span className={cn("inline-flex items-center gap-1", late ? "font-medium text-warning" : "text-muted-foreground")}>
            {late ? <TriangleAlert className="size-3.5" aria-hidden /> : null}
            Entrega {formatPlainDate(order.requested_date)}
            {late ? " · llegaría tarde" : ""}
          </span>
          <span className="text-muted-foreground">{plural(order.lines.length, "línea", "líneas")}</span>
        </p>
        {order.lines.length ? (
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {order.lines.map((line) => (
              <li key={line.id} className="truncate">
                {line.item_code} · {line.item_name} — {formatKg(line.quantity_kg)}
                {line.farm_silo ? ` → ${line.farm_silo}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

function LoadCard({ load }: { load: LoadSummary }) {
  return (
    <li className="rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <Link href={`/logistica/cargas/${load.id}`} className="inline-flex min-h-11 items-center font-medium text-link hover:underline md:min-h-0">
          {load.number}
        </Link>
        <LoadStatusBadge status={load.status} />
      </div>
      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <TruckIcon className="size-4 text-muted-foreground" aria-hidden />
          <span className="font-medium">{load.truck_plate}</span>
          {load.carrier_name ? <span className="text-muted-foreground">· {load.carrier_name}</span> : null}
        </span>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <User className="size-4" aria-hidden />
          {load.driver_name ?? "Sin conductor"}
        </span>
      </p>
      <OccupancyBar className="mt-2" plannedKg={load.planned_kg} capacityKg={load.capacity_kg} />
      {load.customers.length ? (
        <ol className="mt-2 space-y-0.5 text-sm" aria-label="Paradas en orden de descarga">
          {load.customers.map((customer, index) => (
            <li key={`${index}-${customer}`} className="flex gap-2">
              <span className="w-5 shrink-0 text-right text-xs leading-5 text-muted-foreground tabular-nums">{index + 1}.</span>
              <span className="min-w-0 truncate">{customer}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">Sin paradas.</p>
      )}
    </li>
  );
}
