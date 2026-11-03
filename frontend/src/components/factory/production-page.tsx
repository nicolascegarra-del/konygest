"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CheckCheck, Pencil, Play, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataList, type DataColumn } from "@/components/common/data-list";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { formatKg, formatPlainDate } from "@/lib/format";
import { ORDER_STATUS_LABELS, ORDER_STATUSES } from "@/lib/labels";
import type { Page } from "@/types/api";
import type { OrderStatus, ProductionOrder } from "@/types/fase1";

import { LookupSelect, OrderStatusBadge, useCanWrite } from "./common";
import { FinishDialog, invalidateProduction, OrderDialog } from "./production-dialogs";

const PAGE_SIZE = 25;

interface Filters {
  status: OrderStatus | "";
  item_id: string;
  date_from: string;
  date_to: string;
}

/** Órdenes de fabricación: planificar, empezar, terminar (genera el stock) y cancelar. */
export function ProductionPage() {
  const queryClient = useQueryClient();
  const canManage = useCanWrite("fabricacion.gestionar");
  const [filters, setFilters] = useState<Filters>({ status: "", item_id: "", date_from: "", date_to: "" });
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<ProductionOrder | "new" | null>(null);
  const [finishing, setFinishing] = useState<ProductionOrder | null>(null);
  const [cancelling, setCancelling] = useState<ProductionOrder | null>(null);
  const set = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  };

  const query = useQuery({
    queryKey: ["production", "orders", { ...filters, offset }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<Page<ProductionOrder>>("/production/orders", { ...filters, offset, limit: PAGE_SIZE }, signal),
  });

  const start = useMutation({
    mutationFn: (order: ProductionOrder) => api.post<ProductionOrder>(`/production/orders/${order.id}/start`),
    onSuccess: (saved) => {
      toast.success(`Orden ${saved.number} en curso.`);
      invalidateProduction(queryClient);
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });
  const cancel = useMutation({
    mutationFn: (order: ProductionOrder) => api.post<ProductionOrder>(`/production/orders/${order.id}/cancel`),
    onSuccess: (saved) => {
      toast.success(`Orden ${saved.number} cancelada.`);
      setCancelling(null);
      invalidateProduction(queryClient);
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  const filtered = Object.values(filters).some(Boolean);
  const open = (order: ProductionOrder) => order.status === "planned" || order.status === "in_progress";

  const columns: DataColumn<ProductionOrder>[] = [
    {
      key: "number",
      header: "Orden",
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.number}</p>
          <p className="truncate text-xs text-muted-foreground">Prevista el {formatPlainDate(row.planned_date)}</p>
        </div>
      ),
    },
    { key: "item", header: "Pienso", render: (row) => `${row.item_code} · ${row.item_name}` },
    { key: "silo", header: "Silo", render: (row) => row.silo_name },
    {
      key: "kg",
      header: "Previsto / producido",
      render: (row) => (
        <span className="tabular-nums">
          {formatKg(row.planned_kg)}
          <span className="text-muted-foreground"> / {row.produced_kg === null ? "—" : formatKg(row.produced_kg)}</span>
        </span>
      ),
    },
    { key: "status", header: "Estado", render: (row) => <OrderStatusBadge status={row.status} /> },
    ...(canManage
      ? [
          {
            key: "actions",
            header: "Acciones",
            isActions: true,
            render: (row: ProductionOrder) =>
              open(row) ? (
                <div className="flex flex-wrap gap-2">
                  {row.status === "planned" ? (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setEditing(row)}>
                        <Pencil aria-hidden /> Editar
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        loading={start.isPending && start.variables?.id === row.id}
                        onClick={() => start.mutate(row)}
                      >
                        <Play aria-hidden /> Empezar
                      </Button>
                    </>
                  ) : null}
                  <Button size="sm" onClick={() => setFinishing(row)}>
                    <CheckCheck aria-hidden /> Terminar
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setCancelling(row)}>
                    <Ban aria-hidden /> Cancelar
                  </Button>
                </div>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Fabricación"
        description="Órdenes de fabricación de pienso. Al terminarlas, lo producido entra en el stock."
        actions={
          canManage ? (
            <Button onClick={() => setEditing("new")}>
              <Plus aria-hidden /> Nueva orden
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Select value={filters.status} onChange={(event) => set({ status: event.target.value as OrderStatus | "" })} aria-label="Estado">
          <option value="">Todos los estados</option>
          {ORDER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {ORDER_STATUS_LABELS[status]}
            </option>
          ))}
        </Select>
        <LookupSelect
          lookup="items"
          kind="product"
          value={filters.item_id}
          onChange={(value) => set({ item_id: value })}
          emptyLabel="Todos los piensos"
          ariaLabel="Pienso"
        />
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Prevista desde
          <Input type="date" value={filters.date_from} max={filters.date_to || undefined} onChange={(event) => set({ date_from: event.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Prevista hasta
          <Input type="date" value={filters.date_to} min={filters.date_from || undefined} onChange={(event) => set({ date_to: event.target.value })} />
        </label>
      </div>

      {query.isPending ? (
        <LoadingBlock rows={6} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? "Ninguna orden coincide con los filtros" : "Todavía no hay órdenes de fabricación"}
          description={filtered ? "Prueba con otras fechas o estados." : "Planifica la primera orden para empezar a fabricar."}
          action={
            !filtered && canManage ? (
              <Button onClick={() => setEditing("new")}>
                <Plus aria-hidden /> Nueva orden
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <DataList rows={query.data.items} columns={columns} rowKey={(row) => row.id} />
          <Pagination offset={offset} limit={PAGE_SIZE} total={query.data.total} onChange={setOffset} />
        </>
      )}

      {editing !== null ? <OrderDialog order={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      {finishing ? <FinishDialog order={finishing} onClose={() => setFinishing(null)} /> : null}
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(value) => !value && setCancelling(null)}
        title={`¿Cancelar la orden ${cancelling?.number ?? ""}?`}
        description="La orden quedará cancelada y no se podrá terminar. No se mueve stock."
        confirmLabel="Cancelar orden"
        destructive
        loading={cancel.isPending}
        onConfirm={() => cancelling && cancel.mutate(cancelling)}
      />
    </>
  );
}
