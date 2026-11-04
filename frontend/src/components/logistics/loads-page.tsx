"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { DataList, type DataColumn } from "@/components/common/data-list";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from "@/components/common/states";
import { useCanWrite } from "@/components/factory/common";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatPlainDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Page } from "@/types/api";
import type { LoadSummary } from "@/types/fase3";

import { LoadStatusBadge, OccupancyBar, plural, useTrucks } from "./common";

const PAGE_SIZE = 25;

export const LOAD_STATUS_TABS: { value: string; label: string }[] = [
  { value: "", label: "Todas" },
  { value: "planned", label: "Planificadas" },
  { value: "ready", label: "Listas para cargar" },
  { value: "loaded", label: "Cargadas" },
  { value: "delivered", label: "Entregadas" },
  { value: "cancelled", label: "Canceladas" },
];

export const loadColumns: DataColumn<LoadSummary>[] = [
  {
    key: "number",
    header: "Carga",
    render: (row) => (
      <Link href={`/logistica/cargas/${row.id}`} className="inline-flex min-h-11 items-center font-medium text-link hover:underline md:min-h-0">
        {row.number}
      </Link>
    ),
  },
  { key: "date", header: "Fecha", render: (row) => formatPlainDate(row.load_date) },
  {
    key: "truck",
    header: "Camión",
    render: (row) => (
      <div className="min-w-0">
        <p className="font-medium">{row.truck_plate}</p>
        <p className="truncate text-xs text-muted-foreground">{row.driver_name ?? "Sin conductor"}</p>
      </div>
    ),
  },
  {
    key: "stops",
    header: "Paradas",
    render: (row) => (
      <div className="min-w-0 md:max-w-64">
        <p>{plural(row.stop_count, "parada", "paradas")}</p>
        <p className="truncate text-xs text-muted-foreground">{row.customers.join(" → ")}</p>
      </div>
    ),
  },
  {
    key: "kg",
    header: "Kilos",
    render: (row) => <OccupancyBar className="w-44 md:w-48" plannedKg={row.planned_kg} capacityKg={row.capacity_kg} />,
  },
  { key: "status", header: "Estado", render: (row) => <LoadStatusBadge status={row.status} /> },
];

/** Listado de cargas con filtros por estado, fechas y camión. */
export function LoadsPage() {
  const canPlan = useCanWrite("logistica.planificar");
  const trucks = useTrucks();
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [truckId, setTruckId] = useState("");
  const [offset, setOffset] = useState(0);

  const params = { status, date_from: dateFrom, date_to: dateTo, truck_id: truckId };
  const query = useQuery({
    queryKey: ["loads", "list", { ...params, offset }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => api.get<Page<LoadSummary>>("/loads", { ...params, offset, limit: PAGE_SIZE }, signal),
  });
  const filtered = Object.values(params).some(Boolean);
  const reset = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  return (
    <>
      <PageHeader
        title="Cargas"
        description="Viajes de camión: planificación, orden de carga, pesada y entrega."
        actions={
          canPlan ? (
            <Button asChild>
              <Link href="/logistica/cargas/nueva">
                <Plus aria-hidden /> Nueva carga
              </Link>
            </Button>
          ) : undefined
        }
      />

      <div role="tablist" aria-label="Estado" className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1">
        {LOAD_STATUS_TABS.map((tab) => (
          <button
            key={tab.value || "all"}
            type="button"
            role="tab"
            aria-selected={status === tab.value}
            onClick={() => reset(() => setStatus(tab.value))}
            className={cn(
              "min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors md:min-h-9",
              status === tab.value ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Desde
          <Input type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => reset(() => setDateFrom(event.target.value))} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Hasta
          <Input type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => reset(() => setDateTo(event.target.value))} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Camión
          <Select value={truckId} onChange={(event) => reset(() => setTruckId(event.target.value))}>
            <option value="">Todos los camiones</option>
            {(trucks.data?.items ?? []).map((truck) => (
              <option key={truck.id} value={truck.id}>
                {truck.plate}
              </option>
            ))}
          </Select>
        </label>
        {filtered ? (
          <Button
            variant="ghost"
            className="self-end justify-self-start"
            onClick={() =>
              reset(() => {
                setStatus("");
                setDateFrom("");
                setDateTo("");
                setTruckId("");
              })
            }
          >
            Quitar filtros
          </Button>
        ) : null}
      </div>

      {query.isPending ? (
        <LoadingBlock rows={6} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? "Ninguna carga coincide con los filtros" : "Todavía no hay cargas"}
          description={filtered ? "Prueba con otro estado, fechas o camión." : "Planifica la primera desde el tablero."}
          action={
            !filtered && canPlan ? (
              <Button asChild>
                <Link href="/logistica">Ir a planificación</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <DataList rows={query.data.items} columns={loadColumns} rowKey={(row) => row.id} />
          <Pagination offset={offset} limit={PAGE_SIZE} total={query.data.total} onChange={setOffset} />
        </>
      )}
    </>
  );
}
