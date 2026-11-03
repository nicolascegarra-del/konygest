"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { DataList, type DataColumn } from "@/components/common/data-list";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from "@/components/common/states";
import { useCanWrite } from "@/components/factory/common";
import { CustomerPicker } from "@/components/masters/customer-picker";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { optionLabel, useMasterLookups } from "@/hooks/use-master-lookups";
import { api } from "@/lib/api";
import { formatKg, formatMoney, formatPlainDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Page } from "@/types/api";
import type { SalesOrderSummary } from "@/types/fase2";

import { ManualPriceFlag, SalesOrderStatusBadge, useIsOwnScope } from "./common";

const PAGE_SIZE = 25;

/** Pestañas de estado: el valor es el parámetro `status` (varios separados por coma). */
export const STATUS_TABS: { value: string; label: string }[] = [
  { value: "", label: "Todos" },
  { value: "draft", label: "Borradores" },
  { value: "pending", label: "Pendientes" },
  { value: "rejected", label: "Rechazados" },
  { value: "confirmed", label: "Confirmados" },
  { value: "planned,loaded", label: "En reparto" },
  { value: "delivered", label: "Entregados" },
  { value: "invoiced", label: "Facturados" },
  { value: "cancelled", label: "Cancelados" },
];

interface Filters {
  status: string;
  customer_id: string;
  sales_rep_id: string;
  date_from: string;
  date_to: string;
  mine: boolean;
}

const EMPTY_FILTERS: Filters = { status: "", customer_id: "", sales_rep_id: "", date_from: "", date_to: "", mine: false };

/** Columnas comunes del listado y de la bandeja de validación. */
export function orderColumns(options: { showRep: boolean }): DataColumn<SalesOrderSummary>[] {
  return [
    {
      key: "number",
      header: "Pedido",
      render: (row) => (
        <Link href={`/pedidos/${row.id}`} className="inline-flex min-h-11 flex-col justify-center text-link hover:underline md:min-h-0">
          <span className="font-medium">{row.number}</span>
          <span className="text-xs text-muted-foreground">
            {row.line_count} {row.line_count === 1 ? "línea" : "líneas"}
          </span>
        </Link>
      ),
    },
    {
      key: "customer",
      header: "Cliente",
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate">{row.customer_name}</p>
          <p className="truncate text-xs text-muted-foreground">{row.farm_name}</p>
        </div>
      ),
    },
    ...(options.showRep ? [{ key: "rep", header: "Comercial", render: (row: SalesOrderSummary) => row.sales_rep_name ?? "—" }] : []),
    { key: "date", header: "Entrega", render: (row) => formatPlainDate(row.requested_date) },
    { key: "kg", header: "Kilos", render: (row) => <span className="tabular-nums">{formatKg(row.total_kg)}</span> },
    {
      key: "amount",
      header: "Importe",
      render: (row) => (
        <span className="inline-flex flex-col items-end gap-0.5 md:items-start">
          <span className="tabular-nums">{formatMoney(row.total_amount)}</span>
          {row.has_manual_price ? <ManualPriceFlag /> : null}
        </span>
      ),
    },
    { key: "status", header: "Estado", render: (row) => <SalesOrderStatusBadge status={row.status} /> },
  ];
}

/** Listado de pedidos con filtros por estado, búsqueda, cliente, comercial y fechas de entrega. */
export function OrdersPage() {
  const canCreate = useCanWrite("pedidos.crear");
  const ownScope = useIsOwnScope("pedidos.ver");
  const lookups = useMasterLookups(!ownScope);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const debouncedSearch = useDebouncedValue(search.trim());
  const set = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  };

  const params = {
    status: filters.status,
    customer_id: filters.customer_id,
    sales_rep_id: filters.sales_rep_id,
    date_from: filters.date_from,
    date_to: filters.date_to,
    mine: filters.mine ? true : undefined,
    search: debouncedSearch,
  };
  const query = useQuery({
    queryKey: ["orders", "list", { ...params, offset }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => api.get<Page<SalesOrderSummary>>("/orders", { ...params, offset, limit: PAGE_SIZE }, signal),
  });

  const filtered = !!debouncedSearch || Object.entries(filters).some(([, value]) => Boolean(value));
  const extraFilters = [filters.customer_id, filters.sales_rep_id, filters.date_from, filters.date_to, filters.mine].filter(Boolean).length;

  return (
    <>
      <PageHeader
        title="Pedidos"
        description={ownScope ? "Tus pedidos y los de tus clientes." : "Pedidos de los comerciales y su validación en oficina."}
        actions={
          canCreate ? (
            <Button asChild>
              <Link href="/pedidos/nuevo">
                <Plus aria-hidden /> Nuevo pedido
              </Link>
            </Button>
          ) : undefined
        }
      />

      <div role="tablist" aria-label="Estado" className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value || "all"}
            type="button"
            role="tab"
            aria-selected={filters.status === tab.value}
            onClick={() => set({ status: tab.value })}
            className={cn(
              "min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors md:min-h-9",
              filters.status === tab.value
                ? "border-primary bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="mb-3 flex gap-2">
        <Input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
          placeholder="Buscar por número o cliente"
          aria-label="Buscar pedidos"
          className="min-w-0 flex-1"
        />
        <Button
          variant="outline"
          className="md:hidden"
          aria-expanded={showFilters}
          aria-controls="order-filters"
          onClick={() => setShowFilters((value) => !value)}
        >
          <SlidersHorizontal aria-hidden /> Filtros{extraFilters ? ` (${extraFilters})` : ""}
        </Button>
      </div>

      <div id="order-filters" className={cn("mb-4 gap-3 md:grid md:grid-cols-2 xl:grid-cols-4", showFilters ? "grid" : "hidden")}>
        <div className="space-y-1">
          <label htmlFor="filter-customer" className="text-xs text-muted-foreground">
            Cliente
          </label>
          <CustomerPicker
            id="filter-customer"
            value={filters.customer_id}
            onChange={(value) => set({ customer_id: value })}
            emptyLabel="Todos los clientes"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 self-end">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Entrega desde
            <Input type="date" value={filters.date_from} max={filters.date_to || undefined} onChange={(event) => set({ date_from: event.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Entrega hasta
            <Input type="date" value={filters.date_to} min={filters.date_from || undefined} onChange={(event) => set({ date_to: event.target.value })} />
          </label>
        </div>
        {!ownScope ? (
          <>
            <label className="flex flex-col gap-1 self-end text-xs text-muted-foreground">
              Comercial
              <Select value={filters.sales_rep_id} onChange={(event) => set({ sales_rep_id: event.target.value })}>
                <option value="">Todos los comerciales</option>
                {(lookups.data?.sales_reps ?? []).map((rep) => (
                  <option key={rep.id} value={rep.id}>
                    {optionLabel(rep)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex min-h-11 items-center gap-2 self-end text-sm">
              <input
                type="checkbox"
                className="size-5 accent-[var(--color-primary)]"
                checked={filters.mine}
                onChange={(event) => set({ mine: event.target.checked })}
              />
              Solo los que llevo o he creado
            </label>
          </>
        ) : null}
        {filtered ? (
          <Button
            variant="ghost"
            className="justify-self-start self-end"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setSearch("");
              setOffset(0);
            }}
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
          title={filtered ? "Ningún pedido coincide con los filtros" : "Todavía no hay pedidos"}
          description={filtered ? "Prueba con otro estado, cliente o fechas." : "Los pedidos de los comerciales aparecerán aquí."}
          action={
            !filtered && canCreate ? (
              <Button asChild>
                <Link href="/pedidos/nuevo">
                  <Plus aria-hidden /> Nuevo pedido
                </Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <DataList rows={query.data.items} columns={orderColumns({ showRep: !ownScope })} rowKey={(row) => row.id} />
          <Pagination offset={offset} limit={PAGE_SIZE} total={query.data.total} onChange={setOffset} />
        </>
      )}
    </>
  );
}
