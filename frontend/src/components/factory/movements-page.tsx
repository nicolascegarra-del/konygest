"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { DataList, type DataColumn } from "@/components/common/data-list";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from "@/components/common/states";
import { Input, Select } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { MOVEMENT_KIND_LABELS, MOVEMENT_KINDS } from "@/lib/labels";
import type { Page } from "@/types/api";
import type { MovementKind, StockMovement } from "@/types/fase1";

import { LookupSelect, SignedKg } from "./common";

const PAGE_SIZE = 50;

interface Filters {
  item_id: string;
  silo_id: string;
  kind: MovementKind | "";
  date_from: string;
  date_to: string;
}

const EMPTY: Filters = { item_id: "", silo_id: "", kind: "", date_from: "", date_to: "" };

/** Libro de movimientos de stock, del más reciente al más antiguo. */
export function MovementsPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [offset, setOffset] = useState(0);
  const set = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  };

  const query = useQuery({
    queryKey: ["stock", "movements", { ...filters, offset }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<Page<StockMovement>>("/stock/movements", { ...filters, offset, limit: PAGE_SIZE }, signal),
  });
  const filtered = Object.values(filters).some(Boolean);

  const columns: DataColumn<StockMovement>[] = [
    {
      key: "item",
      header: "Artículo",
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.item_name}</p>
          <p className="truncate text-xs text-muted-foreground">{formatDateTime(row.occurred_at)}</p>
        </div>
      ),
    },
    { key: "kind", header: "Tipo", render: (row) => MOVEMENT_KIND_LABELS[row.kind] ?? row.kind },
    { key: "silo", header: "Silo", render: (row) => row.silo_name },
    { key: "quantity", header: "Cantidad", render: (row) => <SignedKg value={row.quantity_kg} /> },
    {
      key: "notes",
      header: "Detalle",
      render: (row) => {
        const text = [row.lot ? `Lote ${row.lot}` : null, row.notes].filter(Boolean).join(" · ");
        return text ? <span className="line-clamp-2 text-muted-foreground">{text}</span> : "—";
      },
    },
    { key: "user", header: "Usuario", render: (row) => row.user_name ?? "—" },
  ];

  return (
    <>
      <PageHeader title="Movimientos de stock" description="Todas las entradas y salidas de cada silo." />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <LookupSelect lookup="items" value={filters.item_id} onChange={(value) => set({ item_id: value })} emptyLabel="Todos los artículos" ariaLabel="Artículo" />
        <LookupSelect lookup="silos" value={filters.silo_id} onChange={(value) => set({ silo_id: value })} emptyLabel="Todos los silos" ariaLabel="Silo" />
        <Select value={filters.kind} onChange={(event) => set({ kind: event.target.value as MovementKind | "" })} aria-label="Tipo de movimiento">
          <option value="">Todos los tipos</option>
          {MOVEMENT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {MOVEMENT_KIND_LABELS[kind]}
            </option>
          ))}
        </Select>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Desde
          <Input type="date" value={filters.date_from} max={filters.date_to || undefined} onChange={(event) => set({ date_from: event.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Hasta
          <Input type="date" value={filters.date_to} min={filters.date_from || undefined} onChange={(event) => set({ date_to: event.target.value })} />
        </label>
      </div>

      {query.isPending ? (
        <LoadingBlock rows={8} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? "Ningún movimiento coincide con los filtros" : "Todavía no hay movimientos"}
          description={filtered ? "Prueba con otras fechas o quita algún filtro." : "Aparecerán con la primera entrada, fabricación o ajuste."}
        />
      ) : (
        <>
          <DataList rows={query.data.items} columns={columns} rowKey={(row) => row.id} />
          <Pagination offset={offset} limit={PAGE_SIZE} total={query.data.total} onChange={setOffset} />
        </>
      )}
    </>
  );
}
