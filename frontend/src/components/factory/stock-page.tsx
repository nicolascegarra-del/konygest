"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ClipboardCheck, PackagePlus, Scale, Search } from "lucide-react";
import { useState } from "react";

import { DataList, type DataColumn } from "@/components/common/data-list";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api } from "@/lib/api";
import { formatKg } from "@/lib/format";
import { ITEM_KIND_LABELS } from "@/lib/labels";
import type { Page } from "@/types/api";
import type { ItemKind, StockLevel, StockSummaryRow } from "@/types/fase1";

import { AdjustmentDialog } from "./adjustment-dialog";
import { LookupSelect, Tabs, useCanWrite } from "./common";
import { InventoryDialog } from "./inventory-dialog";
import { ReceiptDialog } from "./receipt-dialog";

const PAGE_SIZE = 50;

type View = "items" | "silos";
type Action = "receipt" | "adjustment" | "inventory" | null;

function KindSelect({ value, onChange }: { value: ItemKind | ""; onChange: (value: ItemKind | "") => void }) {
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value as ItemKind | "")} aria-label="Tipo de artículo" className="sm:w-56">
      <option value="">Piensos y materias primas</option>
      <option value="product">{ITEM_KIND_LABELS.product}</option>
      <option value="raw_material">{ITEM_KIND_LABELS.raw_material}</option>
    </Select>
  );
}

function itemCell(name: string, code: string) {
  return (
    <div className="min-w-0">
      <p className="truncate font-medium">{name}</p>
      <p className="truncate text-xs text-muted-foreground">{code}</p>
    </div>
  );
}

/** Stock: total por artículo (con roturas de mínimo) y desglose por silo, con entradas, ajustes e inventario. */
export function StockPage() {
  const canAdjust = useCanWrite("stock.ajustar");
  const [view, setView] = useState<View>("items");
  const [action, setAction] = useState<Action>(null);

  return (
    <>
      <PageHeader
        title="Stock"
        description="Existencias de piensos y materias primas en la fábrica."
        actions={
          canAdjust ? (
            <>
              <Button onClick={() => setAction("receipt")}>
                <PackagePlus aria-hidden /> Entrada de materia prima
              </Button>
              <Button variant="outline" onClick={() => setAction("adjustment")}>
                <Scale aria-hidden /> Ajuste
              </Button>
              <Button variant="outline" onClick={() => setAction("inventory")}>
                <ClipboardCheck aria-hidden /> Inventario
              </Button>
            </>
          ) : undefined
        }
      />
      <Tabs
        label="Vista del stock"
        value={view}
        onChange={setView}
        tabs={[
          { value: "items", label: "Por artículo" },
          { value: "silos", label: "Por silo" },
        ]}
      />
      {view === "items" ? <SummaryView /> : <LevelsView />}

      {action === "receipt" ? <ReceiptDialog onClose={() => setAction(null)} /> : null}
      {action === "adjustment" ? <AdjustmentDialog onClose={() => setAction(null)} /> : null}
      {action === "inventory" ? <InventoryDialog onClose={() => setAction(null)} /> : null}
    </>
  );
}

function SummaryView() {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<ItemKind | "">("");
  const [belowMin, setBelowMin] = useState(false);
  const [offset, setOffset] = useState(0);
  const debounced = useDebouncedValue(search.trim());

  const query = useQuery({
    queryKey: ["stock", "summary", { search: debounced, kind, belowMin, offset }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<Page<StockSummaryRow>>(
        "/stock/summary",
        { search: debounced, kind, below_min: belowMin || undefined, offset, limit: PAGE_SIZE },
        signal,
      ),
  });

  const columns: DataColumn<StockSummaryRow>[] = [
    { key: "item", header: "Artículo", render: (row) => itemCell(row.item_name, row.item_code) },
    { key: "kind", header: "Tipo", render: (row) => ITEM_KIND_LABELS[row.item_kind] },
    {
      key: "quantity",
      header: "Stock",
      render: (row) => (
        <span className="inline-flex flex-wrap items-center justify-end gap-2 md:justify-start">
          <span className="font-medium tabular-nums">{formatKg(row.quantity_kg)}</span>
          {row.below_min ? <Badge variant="warning">Bajo mínimo</Badge> : null}
        </span>
      ),
    },
    { key: "min", header: "Mínimo", render: (row) => (row.min_stock_kg > 0 ? formatKg(row.min_stock_kg) : "—") },
  ];

  return (
    <>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
            placeholder="Buscar por código o nombre"
            aria-label="Buscar artículos"
            className="pl-9"
          />
        </div>
        <KindSelect
          value={kind}
          onChange={(value) => {
            setKind(value);
            setOffset(0);
          }}
        />
        <div className="flex min-h-11 items-center gap-3 px-1">
          <Switch
            id="stock-below-min"
            checked={belowMin}
            onCheckedChange={(checked) => {
              setBelowMin(checked);
              setOffset(0);
            }}
          />
          <label htmlFor="stock-below-min" className="text-sm">
            Solo bajo mínimo
          </label>
        </div>
      </div>
      {query.isPending ? (
        <LoadingBlock rows={6} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          title={belowMin ? "Ningún artículo está bajo mínimo" : "No hay artículos que mostrar"}
          description={belowMin ? "Todo el stock está por encima de su mínimo." : "Da de alta artículos en Maestros para ver su stock."}
        />
      ) : (
        <>
          <DataList rows={query.data.items} columns={columns} rowKey={(row) => row.item_id} />
          <Pagination offset={offset} limit={PAGE_SIZE} total={query.data.total} onChange={setOffset} />
        </>
      )}
    </>
  );
}

function LevelsView() {
  const [siloId, setSiloId] = useState("");
  const [kind, setKind] = useState<ItemKind | "">("");
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ["stock", "levels", { siloId, kind, offset }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<Page<StockLevel>>("/stock/levels", { silo_id: siloId, kind, offset, limit: PAGE_SIZE }, signal),
  });

  const columns: DataColumn<StockLevel>[] = [
    { key: "silo", header: "Silo", render: (row) => itemCell(row.silo_name, row.silo_code) },
    { key: "item", header: "Artículo", render: (row) => `${row.item_code} · ${row.item_name}` },
    { key: "kind", header: "Tipo", render: (row) => ITEM_KIND_LABELS[row.item_kind] },
    {
      key: "quantity",
      header: "Stock",
      render: (row) => <span className="font-medium tabular-nums">{formatKg(row.quantity_kg)}</span>,
    },
  ];

  return (
    <>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <LookupSelect
          lookup="silos"
          value={siloId}
          onChange={(value) => {
            setSiloId(value);
            setOffset(0);
          }}
          emptyLabel="Todos los silos"
          ariaLabel="Silo"
          className="sm:w-64"
        />
        <KindSelect
          value={kind}
          onChange={(value) => {
            setKind(value);
            setOffset(0);
          }}
        />
      </div>
      {query.isPending ? (
        <LoadingBlock rows={6} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title="No hay stock en los silos" description="Las entradas, la fabricación y los ajustes irán llenándolos." />
      ) : (
        <>
          <DataList rows={query.data.items} columns={columns} rowKey={(row) => `${row.silo_id}-${row.item_id}`} />
          <Pagination offset={offset} limit={PAGE_SIZE} total={query.data.total} onChange={setOffset} />
        </>
      )}
    </>
  );
}
