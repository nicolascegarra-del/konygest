"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCheck, CircleX, Eye } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { DataList, type DataColumn } from "@/components/common/data-list";
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/common/states";
import { useCanWrite } from "@/components/factory/common";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { Page } from "@/types/api";
import type { SalesOrderSummary } from "@/types/fase2";

import { ReasonDialog, ValidateDialog } from "./order-dialogs";
import { orderColumns } from "./orders-page";

const INBOX_LIMIT = 200;

/** Más antiguos primero: por fecha de envío (o de alta si no la hay). La API ordena por entrega desc. */
export function sortOldestFirst(rows: SalesOrderSummary[]): SalesOrderSummary[] {
  const at = (row: SalesOrderSummary) => row.submitted_at ?? row.created_at;
  return [...rows].sort((a, b) => at(a).localeCompare(at(b)) || a.number.localeCompare(b.number));
}

/** Bandeja de oficina: pedidos pendientes de validar, con acceso rápido a validar o rechazar. */
export function ValidationInbox() {
  const canValidate = useCanWrite("pedidos.validar");
  const [action, setAction] = useState<{ type: "validate" | "reject"; order: SalesOrderSummary } | null>(null);
  const query = useQuery({
    queryKey: ["orders", "list", { status: "pending", inbox: true }],
    queryFn: ({ signal }) => api.get<Page<SalesOrderSummary>>("/orders", { status: "pending", limit: INBOX_LIMIT }, signal),
  });

  const columns: DataColumn<SalesOrderSummary>[] = [
    ...orderColumns({ showRep: true }).filter((column) => column.key !== "status"),
    {
      key: "submitted",
      header: "Enviado",
      render: (row) => <span className="text-xs">{formatDateTime(row.submitted_at ?? row.created_at)}</span>,
    },
    {
      key: "actions",
      header: "Acciones",
      isActions: true,
      render: (row) => (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/pedidos/${row.id}`} aria-label={`Revisar el pedido ${row.number}`}>
              <Eye aria-hidden /> Revisar
            </Link>
          </Button>
          {canValidate ? (
            <>
              <Button size="sm" onClick={() => setAction({ type: "validate", order: row })} aria-label={`Validar el pedido ${row.number}`}>
                <CheckCheck aria-hidden /> Validar
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAction({ type: "reject", order: row })} aria-label={`Rechazar el pedido ${row.number}`}>
                <CircleX aria-hidden /> Rechazar
              </Button>
            </>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Por validar"
        description="Pedidos enviados por los comerciales, los más antiguos primero. Revisa riesgo, precios y stock en la ficha."
      />
      {query.isPending ? (
        <LoadingBlock rows={6} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title="Nada por validar" description="No hay pedidos pendientes. Te avisaremos cuando llegue uno." />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            {query.data.total === 1 ? "1 pedido pendiente." : `${query.data.total} pedidos pendientes.`}
            {query.data.total > query.data.items.length ? ` Se muestran los ${query.data.items.length} de entrega más lejana.` : ""}
          </p>
          <DataList rows={sortOldestFirst(query.data.items)} columns={columns} rowKey={(row) => row.id} />
        </>
      )}
      {action?.type === "validate" ? <ValidateDialog order={action.order} onClose={() => setAction(null)} /> : null}
      {action?.type === "reject" ? <ReasonDialog order={action.order} action="reject" onClose={() => setAction(null)} /> : null}
    </>
  );
}
