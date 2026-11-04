"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { FileClock, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { DataList, type DataColumn } from "@/components/common/data-list";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from "@/components/common/states";
import { useCanWrite } from "@/components/factory/common";
import { CustomerPicker } from "@/components/masters/customer-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api } from "@/lib/api";
import { formatPlainDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Page } from "@/types/api";
import type { InvoiceSummary } from "@/types/fase4";

import { invoiceHref, InvoiceKindBadge, InvoiceStatusBadge, Money } from "./common";

const PAGE_SIZE = 25;

export const KIND_TABS: { value: string; label: string }[] = [
  { value: "invoice", label: "Facturas" },
  { value: "credit_note", label: "Abonos" },
  { value: "", label: "Todo" },
];

export const INVOICE_STATUS_TABS: { value: string; label: string }[] = [
  { value: "", label: "Todos los estados" },
  { value: "draft", label: "Borradores" },
  { value: "issued", label: "Emitidas" },
  { value: "cancelled", label: "Anuladas" },
];

interface Filters {
  kind: string;
  status: string;
  customer_id: string;
  date_from: string;
  date_to: string;
}

const EMPTY_FILTERS: Filters = { kind: "invoice", status: "", customer_id: "", date_from: "", date_to: "" };

const COLUMNS: DataColumn<InvoiceSummary>[] = [
  {
    key: "number",
    header: "Número",
    render: (row) => (
      <Link href={invoiceHref(row.id)} className="inline-flex min-h-11 flex-col justify-center text-link hover:underline md:min-h-0">
        <span className="font-medium">{row.number ?? "Borrador"}</span>
        {row.rectified_number ? (
          <span className="text-xs text-muted-foreground">Rectifica {row.rectified_number}</span>
        ) : null}
      </Link>
    ),
  },
  { key: "type", header: "Tipo", render: (row) => <InvoiceKindBadge kind={row.kind} type={row.invoice_type} /> },
  {
    key: "customer",
    header: "Cliente",
    render: (row) => (
      <div className="min-w-0">
        <p className="truncate">{row.customer_name}</p>
        <p className="truncate text-xs text-muted-foreground">{row.customer_code}</p>
      </div>
    ),
  },
  { key: "date", header: "Fecha", render: (row) => formatPlainDate(row.issue_date) },
  { key: "base", header: "Base", render: (row) => <Money value={row.taxable_base} /> },
  { key: "total", header: "Total", render: (row) => <Money value={row.total} strong /> },
  { key: "status", header: "Estado", render: (row) => <InvoiceStatusBadge status={row.status} /> },
];

function Chips({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {tabs.map((tab) => (
        <button
          key={tab.value || "all"}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={cn(
            "min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors md:min-h-9",
            value === tab.value
              ? "border-primary bg-primary text-primary-foreground"
              : "bg-background text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Listado de facturas y abonos con filtros por tipo, estado, cliente, fechas y búsqueda. */
export function InvoicesPage() {
  const canIssue = useCanWrite("facturas.emitir");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const debouncedSearch = useDebouncedValue(search.trim());
  const set = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  };

  const params = { ...filters, search: debouncedSearch };
  const query = useQuery({
    queryKey: ["invoices", "list", { ...params, offset }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => api.get<Page<InvoiceSummary>>("/invoices", { ...params, offset, limit: PAGE_SIZE }, signal),
  });

  const extraFilters = [filters.customer_id, filters.date_from, filters.date_to].filter(Boolean).length;
  const filtered = Boolean(debouncedSearch || filters.status || extraFilters);
  const noun = filters.kind === "credit_note" ? "abonos" : filters.kind === "invoice" ? "facturas" : "facturas ni abonos";

  return (
    <>
      <PageHeader
        title="Facturas"
        description="Facturas y abonos (rectificativas). Las emitidas no se modifican: se corrigen con un abono."
        actions={
          canIssue ? (
            <Button variant="outline" asChild>
              <Link href="/facturacion/pendiente">
                <FileClock aria-hidden /> Pendiente de facturar
              </Link>
            </Button>
          ) : undefined
        }
      />

      <div className="mb-3 space-y-2">
        <Chips label="Tipo" tabs={KIND_TABS} value={filters.kind} onChange={(kind) => set({ kind })} />
        <Chips label="Estado" tabs={INVOICE_STATUS_TABS} value={filters.status} onChange={(status) => set({ status })} />
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
          aria-label="Buscar facturas"
          className="min-w-0 flex-1"
        />
        <Button
          variant="outline"
          className="md:hidden"
          aria-expanded={showFilters}
          aria-controls="invoice-filters"
          onClick={() => setShowFilters((value) => !value)}
        >
          <SlidersHorizontal aria-hidden /> Filtros{extraFilters ? ` (${extraFilters})` : ""}
        </Button>
      </div>

      <div id="invoice-filters" className={cn("mb-4 gap-3 md:grid md:grid-cols-2 xl:grid-cols-3", showFilters ? "grid" : "hidden")}>
        <div className="space-y-1">
          <label htmlFor="invoice-filter-customer" className="text-xs text-muted-foreground">
            Cliente
          </label>
          <CustomerPicker
            id="invoice-filter-customer"
            value={filters.customer_id}
            onChange={(value) => set({ customer_id: value })}
            emptyLabel="Todos los clientes"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 self-end">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Fecha desde
            <Input type="date" value={filters.date_from} max={filters.date_to || undefined} onChange={(event) => set({ date_from: event.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Fecha hasta
            <Input type="date" value={filters.date_to} min={filters.date_from || undefined} onChange={(event) => set({ date_to: event.target.value })} />
          </label>
        </div>
        {filtered ? (
          <Button
            variant="ghost"
            className="justify-self-start self-end"
            onClick={() => {
              setFilters((current) => ({ ...EMPTY_FILTERS, kind: current.kind }));
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
          title={filtered ? "Nada coincide con los filtros" : `Todavía no hay ${noun}`}
          description={
            filtered
              ? "Prueba con otro estado, cliente o fechas."
              : "Las facturas se crean desde los pedidos entregados en «Pendiente de facturar»."
          }
          action={
            !filtered && canIssue ? (
              <Button asChild>
                <Link href="/facturacion/pendiente">Ir a pendiente de facturar</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <DataList rows={query.data.items} columns={COLUMNS} rowKey={(row) => row.id} />
          <Pagination offset={offset} limit={PAGE_SIZE} total={query.data.total} onChange={setOffset} />
        </>
      )}
    </>
  );
}
