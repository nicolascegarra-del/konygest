"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { PackagePlus } from "lucide-react";
import { useState } from "react";

import { DataList, type DataColumn } from "@/components/common/data-list";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatDateTime, formatKg } from "@/lib/format";
import type { Page } from "@/types/api";
import type { RawMaterialReceipt } from "@/types/fase1";

import { useCanWrite } from "./common";
import { ReceiptDialog } from "./receipt-dialog";

const PAGE_SIZE = 50;

/** Listado de entradas de materia prima (pesadas de báscula). */
export function ReceiptsPage() {
  const canAdjust = useCanWrite("stock.ajustar");
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);

  const query = useQuery({
    queryKey: ["stock", "receipts", { offset }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => api.get<Page<RawMaterialReceipt>>("/stock/receipts", { offset, limit: PAGE_SIZE }, signal),
  });

  const columns: DataColumn<RawMaterialReceipt>[] = [
    {
      key: "number",
      header: "Entrada",
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.number}</p>
          <p className="truncate text-xs text-muted-foreground">{formatDateTime(row.received_at)}</p>
        </div>
      ),
    },
    { key: "item", header: "Materia prima", render: (row) => row.item_name },
    { key: "silo", header: "Silo", render: (row) => row.silo_name },
    {
      key: "supplier",
      header: "Proveedor",
      render: (row) => (
        <span>
          {row.supplier || "—"}
          {row.delivery_note ? <span className="block text-xs text-muted-foreground">Albarán {row.delivery_note}</span> : null}
        </span>
      ),
    },
    { key: "plate", header: "Matrícula", render: (row) => (row.plate ? <span className="font-mono">{row.plate}</span> : "—") },
    {
      key: "weights",
      header: "Bruto / tara",
      render: (row) => (
        <span className="tabular-nums text-muted-foreground">
          {formatKg(row.gross_kg)} / {formatKg(row.tare_kg)}
        </span>
      ),
    },
    { key: "net", header: "Neto", render: (row) => <span className="font-medium tabular-nums">{formatKg(row.net_kg)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Entradas de materia prima"
        description="Pesadas de las materias primas recibidas en fábrica."
        actions={
          canAdjust ? (
            <Button onClick={() => setCreating(true)}>
              <PackagePlus aria-hidden /> Nueva entrada
            </Button>
          ) : undefined
        }
      />
      {query.isPending ? (
        <LoadingBlock rows={6} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title="Todavía no hay entradas" description="Registra aquí cada camión de materia prima que llegue." />
      ) : (
        <>
          <DataList rows={query.data.items} columns={columns} rowKey={(row) => row.id} />
          <Pagination offset={offset} limit={PAGE_SIZE} total={query.data.total} onChange={setOffset} />
        </>
      )}
      {creating ? <ReceiptDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
