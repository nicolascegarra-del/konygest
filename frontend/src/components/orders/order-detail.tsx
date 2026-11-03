"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, CheckCheck, CircleX, Pencil, Send, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { DataList, type DataColumn } from "@/components/common/data-list";
import { ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { formatDateTime, formatKg, formatMoney, formatPercent, formatPlainDate, formatPrice } from "@/lib/format";
import type { SalesOrderDetail, SalesOrderLine, SalesOrderStatus } from "@/types/fase2";

import { invalidateOrders, priceDifferencePct, PriceSourceBadge, SalesOrderStatusBadge, samePrice } from "./common";
import { OrderChecksPanel } from "./order-checks";
import { ReasonDialog, ValidateDialog } from "./order-dialogs";

/** Estados en los que tiene sentido revisar riesgo, precio y stock. */
const CHECK_STATUSES: SalesOrderStatus[] = ["draft", "pending", "rejected", "confirmed"];
const VALIDATED_STATUSES: SalesOrderStatus[] = ["confirmed", "planned", "loaded", "delivered", "invoiced"];

export function orderDetailKey(orderId: string) {
  return ["orders", "detail", orderId] as const;
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-sm text-muted-foreground sm:w-36">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children || "—"}</dd>
    </div>
  );
}

function belowReference(line: SalesOrderLine): boolean {
  return (
    line.reference_price !== null &&
    line.unit_price < line.reference_price &&
    !samePrice(line.unit_price, line.reference_price)
  );
}

/** Ficha de un pedido: cabecera, líneas, historial, comprobaciones y acciones según `allowed_actions`. */
export function OrderDetail({ orderId }: { orderId: string }) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<"validate" | "reject" | "cancel" | null>(null);

  const query = useQuery({
    queryKey: orderDetailKey(orderId),
    queryFn: ({ signal }) => api.get<SalesOrderDetail>(`/orders/${orderId}`, undefined, signal),
  });

  const submit = useMutation({
    mutationFn: () => api.post<SalesOrderDetail>(`/orders/${orderId}/submit`),
    onSuccess: (saved) => {
      toast.success(`Pedido ${saved.number} enviado a validar.`);
      invalidateOrders(queryClient);
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  if (query.isPending) return <LoadingBlock rows={6} />;
  if (query.isError) {
    return (
      <>
        <BackLink />
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      </>
    );
  }

  const order = query.data;
  const allowed = new Set(order.allowed_actions);
  const lines = [...order.lines].sort((a, b) => a.position - b.position);

  const columns: DataColumn<SalesOrderLine>[] = [
    {
      key: "item",
      header: "Pienso",
      render: (line) => (
        <div className="min-w-0">
          <p className="font-medium">
            {line.item_code} · {line.item_name}
          </p>
          {line.notes ? <p className="text-xs text-muted-foreground">{line.notes}</p> : null}
        </div>
      ),
    },
    { key: "silo", header: "Silo", render: (line) => line.farm_silo || "—" },
    { key: "kg", header: "Kilos", render: (line) => <span className="tabular-nums">{formatKg(line.quantity_kg)}</span> },
    {
      key: "price",
      header: "Precio",
      render: (line) => (
        <div className="flex flex-col items-end gap-1 md:items-start">
          <span className="flex items-center gap-1.5 tabular-nums">
            {formatPrice(line.unit_price)} <PriceSourceBadge source={line.price_source} />
          </span>
          {belowReference(line) && line.reference_price !== null ? (
            <span className="flex items-center gap-1 text-xs font-medium text-warning">
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
              Ref. {formatPrice(line.reference_price)} ({formatPercent(priceDifferencePct(line.unit_price, line.reference_price))})
            </span>
          ) : null}
        </div>
      ),
    },
    { key: "amount", header: "Importe", render: (line) => <span className="font-medium tabular-nums">{formatMoney(line.amount)}</span> },
  ];

  const ref = { id: order.id, number: order.number };

  return (
    <>
      <BackLink />
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Pedido {order.number}</h1>
            <SalesOrderStatusBadge status={order.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {order.customer_code} · {order.customer_name} — entrega el {formatPlainDate(order.requested_date)}
          </p>
        </div>
        {allowed.size > 0 ? (
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" aria-label="Acciones del pedido">
            {allowed.has("edit") ? (
              <Button variant="outline" asChild>
                <Link href={`/pedidos/${order.id}/editar`}>
                  <Pencil aria-hidden /> Editar
                </Link>
              </Button>
            ) : null}
            {allowed.has("submit") ? (
              <Button loading={submit.isPending} onClick={() => submit.mutate()}>
                <Send aria-hidden /> Enviar a validar
              </Button>
            ) : null}
            {allowed.has("validate") ? (
              <Button onClick={() => setDialog("validate")}>
                <CheckCheck aria-hidden /> Validar
              </Button>
            ) : null}
            {allowed.has("reject") ? (
              <Button variant="outline" onClick={() => setDialog("reject")}>
                <CircleX aria-hidden /> Rechazar
              </Button>
            ) : null}
            {allowed.has("cancel") ? (
              <Button variant="ghost" onClick={() => setDialog("cancel")}>
                <Ban aria-hidden /> Cancelar pedido
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {(order.status === "rejected" || order.status === "cancelled") && order.status_reason ? (
        <div role="alert" className="mb-4 flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 text-sm">
            <p className="font-semibold">
              {order.status === "rejected" ? "Pedido rechazado por oficina" : "Pedido cancelado"}
            </p>
            <p className="mt-1 whitespace-pre-line break-words">{order.status_reason}</p>
            {order.status === "rejected" && allowed.has("edit") ? (
              <p className="mt-1 text-muted-foreground">Corrígelo y vuelve a enviarlo a validar.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Datos del pedido</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2">
                <InfoRow label="Cliente">
                  {order.customer_code} · {order.customer_name}
                </InfoRow>
                <InfoRow label="Explotación">{order.farm_name}</InfoRow>
                <InfoRow label="Fecha de entrega">{formatPlainDate(order.requested_date)}</InfoRow>
                <InfoRow label="Comercial">{order.sales_rep_name}</InfoRow>
                <InfoRow label="Notas">{order.notes ? <span className="whitespace-pre-line">{order.notes}</span> : null}</InfoRow>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Líneas</CardTitle>
            </CardHeader>
            <CardContent>
              <DataList rows={lines} columns={columns} rowKey={(line) => line.id} />
              <dl className="mt-4 flex flex-wrap justify-end gap-x-6 gap-y-1 border-t pt-3 text-sm">
                <div className="flex items-baseline gap-2">
                  <dt className="text-muted-foreground">Total</dt>
                  <dd className="font-semibold tabular-nums">{formatKg(order.total_kg)}</dd>
                </div>
                <div className="flex items-baseline gap-2">
                  <dt className="text-muted-foreground">Importe sin IVA</dt>
                  <dd className="text-base font-bold tabular-nums">{formatMoney(order.total_amount)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          {CHECK_STATUSES.includes(order.status) ? <OrderChecksPanel orderId={order.id} /> : null}
          <Card>
            <CardHeader>
              <CardTitle>Historial</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-2 text-sm">
                <li>
                  <span className="text-muted-foreground">Creado</span> el {formatDateTime(order.created_at)}
                  {order.created_by_name ? ` por ${order.created_by_name}` : ""}
                </li>
                {order.submitted_at ? (
                  <li>
                    <span className="text-muted-foreground">Enviado a validar</span> el {formatDateTime(order.submitted_at)}
                  </li>
                ) : null}
                {VALIDATED_STATUSES.includes(order.status) && order.validated_at ? (
                  <li>
                    <span className="text-muted-foreground">Validado</span> el {formatDateTime(order.validated_at)}
                    {order.validated_by_name ? ` por ${order.validated_by_name}` : ""}
                  </li>
                ) : null}
                {order.status === "rejected" ? (
                  <li>
                    <span className="text-muted-foreground">Rechazado</span>
                    {order.validated_by_name ? ` por ${order.validated_by_name}` : ""}
                    {order.validated_at ? ` el ${formatDateTime(order.validated_at)}` : ""}
                  </li>
                ) : null}
                <li>
                  <span className="text-muted-foreground">Última modificación</span> el {formatDateTime(order.updated_at)}
                </li>
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>

      {dialog === "validate" ? <ValidateDialog order={ref} onClose={() => setDialog(null)} /> : null}
      {dialog === "reject" || dialog === "cancel" ? (
        <ReasonDialog order={ref} action={dialog} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
}

function BackLink() {
  return (
    <Button variant="ghost" size="sm" asChild className="mb-2 -ml-2">
      <Link href="/pedidos">
        <ArrowLeft aria-hidden /> Pedidos
      </Link>
    </Button>
  );
}
