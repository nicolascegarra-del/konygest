"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CircleCheck, MapPin, Pencil, Scale, Send, TriangleAlert, Undo2 } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorState, LoadingBlock } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { formatDateTime, formatKg, formatPlainDate } from "@/lib/format";
import { netWeight } from "@/lib/loads";
import { cn } from "@/lib/utils";
import type { LoadDetail, LoadItem, LoadStop } from "@/types/fase3";

import { BackLink, invalidateLogistics, loadDetailKey, LoadStatusBadge, OccupancyBar, PdfButton, plural } from "./common";
import { CancelLoadDialog, DeliverDialog } from "./load-dialogs";

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-sm text-muted-foreground sm:w-36">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children || "—"}</dd>
    </div>
  );
}

export function loadingOrderPath(loadId: string) {
  return `/loads/${loadId}/loading-order.pdf`;
}

export function deliveryNotePath(loadId: string, stopId: string) {
  return `/loads/${loadId}/stops/${stopId}/delivery-note.pdf`;
}

/** ¿Tiene ya la parada su albarán? (se numera al registrar la pesada). */
export function hasDeliveryNote(stop: LoadStop): boolean {
  return !!stop.delivery_note_number;
}

/**
 * Compartimentos del camión como cajas: capacidad, pienso, cliente y kilos previstos y reales.
 */
export function CompartmentsView({ load }: { load: Pick<LoadDetail, "compartments" | "items" | "stops"> }) {
  const stops = new Map(load.stops.map((stop) => [stop.id, stop]));
  const byCompartment = new Map<number, LoadItem>(load.items.map((item) => [item.compartment, item]));
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" aria-label="Compartimentos del camión">
      {load.compartments.map((capacity, index) => {
        const item = byCompartment.get(index + 1);
        const stop = item ? stops.get(item.stop_id) : undefined;
        const kg = item ? (item.actual_kg ?? item.planned_kg) : 0;
        const fill = capacity > 0 ? Math.min((kg / capacity) * 100, 100) : 0;
        return (
          <li
            key={index}
            className={cn("relative overflow-hidden rounded-lg border p-3 text-sm", !item && "border-dashed text-muted-foreground")}
          >
            {/* Relleno de fondo proporcional a los kilos (decorativo: los kilos van en texto). */}
            <span aria-hidden className="absolute inset-x-0 bottom-0 bg-primary/10" style={{ height: `${fill}%` }} />
            <div className="relative">
              <p className="flex justify-between gap-2">
                <span className="font-semibold">C{index + 1}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{formatKg(capacity)}</span>
              </p>
              {item ? (
                <>
                  <p className="mt-1 truncate font-medium" title={`${item.item_code} · ${item.item_name}`}>
                    {item.item_code} · {item.item_name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {stop ? `${stop.sequence}. ${stop.customer_name}` : ""}
                    {item.farm_silo ? ` → ${item.farm_silo}` : ""}
                  </p>
                  <p className="mt-1 text-xs tabular-nums">
                    Previsto <span className="font-medium">{formatKg(item.planned_kg)}</span>
                  </p>
                  {item.actual_kg !== null ? (
                    <p className="text-xs tabular-nums">
                      Real <span className="font-semibold">{formatKg(item.actual_kg)}</span>
                      {item.silo_name ? <span className="text-muted-foreground"> · {item.silo_name}</span> : null}
                      {item.lot ? <span className="text-muted-foreground"> · lote {item.lot}</span> : null}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="mt-1">Vacío</p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Ficha de una carga: cabecera, compartimentos, paradas y acciones según `allowed_actions`. */
export function LoadDetailView({ loadId }: { loadId: string }) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<"release" | "unrelease" | "cancel" | null>(null);
  const [delivering, setDelivering] = useState<LoadStop | null>(null);

  const query = useQuery({
    queryKey: loadDetailKey(loadId),
    queryFn: ({ signal }) => api.get<LoadDetail>(`/loads/${loadId}`, undefined, signal),
  });

  const transition = useMutation({
    mutationFn: (action: "release" | "unrelease") => api.post<LoadDetail>(`/loads/${loadId}/${action}`),
    onSuccess: (saved, action) => {
      toast.success(
        action === "release"
          ? `Orden de carga ${saved.number} emitida a fábrica.`
          : `Carga ${saved.number} devuelta a planificación.`,
      );
      invalidateLogistics(queryClient);
      setDialog(null);
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  if (query.isPending) return <LoadingBlock rows={6} />;
  if (query.isError) {
    return (
      <>
        <BackLink href="/logistica/cargas" label="Cargas" />
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      </>
    );
  }

  const load = query.data;
  const allowed = new Set(load.allowed_actions);
  const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  const ref = { id: load.id, number: load.number };
  const net = netWeight(load.gross_kg, load.tare_kg);
  const actualTotal = load.items.reduce((sum, item) => sum + (item.actual_kg ?? 0), 0);

  return (
    <>
      <BackLink href="/logistica/cargas" label="Cargas" />
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Carga {load.number}</h1>
            <LoadStatusBadge status={load.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatPlainDate(load.load_date)} · {load.truck_plate}
            {load.driver_name ? ` · ${load.driver_name}` : " · sin conductor"} · {plural(load.stop_count, "parada", "paradas")}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" aria-label="Acciones de la carga">
          {allowed.has("edit") ? (
            <Button variant="outline" asChild>
              <Link href={`/logistica/cargas/${load.id}/editar`}>
                <Pencil aria-hidden /> Editar
              </Link>
            </Button>
          ) : null}
          {allowed.has("release") ? (
            <Button onClick={() => setDialog("release")}>
              <Send aria-hidden /> Emitir a fábrica
            </Button>
          ) : null}
          {allowed.has("unrelease") ? (
            <Button variant="outline" onClick={() => setDialog("unrelease")}>
              <Undo2 aria-hidden /> Devolver a planificación
            </Button>
          ) : null}
          {allowed.has("load") ? (
            <Button asChild>
              <Link href={`/fabrica/cargas/${load.id}`}>
                <Scale aria-hidden /> Registrar pesada
              </Link>
            </Button>
          ) : null}
          {load.status !== "cancelled" ? (
            <PdfButton path={loadingOrderPath(load.id)} filename={`${load.number}.pdf`} label="Orden de carga (PDF)" />
          ) : null}
          {allowed.has("cancel") ? (
            <Button variant="ghost" onClick={() => setDialog("cancel")}>
              <Ban aria-hidden /> Cancelar carga
            </Button>
          ) : null}
        </div>
      </div>

      {load.status === "cancelled" && load.status_reason ? (
        <div role="alert" className="mb-4 flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 text-sm">
            <p className="font-semibold">Carga cancelada</p>
            <p className="mt-1 whitespace-pre-line break-words">{load.status_reason}</p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Compartimentos</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <OccupancyBar plannedKg={load.planned_kg} capacityKg={load.capacity_kg} />
              <CompartmentsView load={load} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Paradas</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3">
                {stops.map((stop) => (
                  <StopRow
                    key={stop.id}
                    loadId={load.id}
                    stop={stop}
                    canDeliver={allowed.has("deliver") && !stop.delivered_at}
                    onDeliver={() => setDelivering(stop)}
                  />
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Datos</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2">
                <InfoRow label="Fecha">{formatPlainDate(load.load_date)}</InfoRow>
                <InfoRow label="Camión">
                  {load.truck_plate}
                  {load.carrier_name ? ` (${load.carrier_name})` : ""}
                </InfoRow>
                <InfoRow label="Conductor">{load.driver_name}</InfoRow>
                <InfoRow label="Kilos">
                  <span className="tabular-nums">
                    {formatKg(load.planned_kg)} de {formatKg(load.capacity_kg)}
                  </span>
                </InfoRow>
                {load.loaded_at ? (
                  <InfoRow label="Pesada">
                    <span className="tabular-nums">
                      {formatKg(actualTotal)} reales
                      {net !== null ? ` · báscula ${formatKg(net)} neto (${formatKg(load.gross_kg)} − ${formatKg(load.tare_kg)})` : ""}
                    </span>
                  </InfoRow>
                ) : null}
                <InfoRow label="Notas">{load.notes ? <span className="whitespace-pre-line">{load.notes}</span> : null}</InfoRow>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Historial</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-2 text-sm">
                <li>
                  <span className="text-muted-foreground">Creada</span> el {formatDateTime(load.created_at)}
                  {load.created_by_name ? ` por ${load.created_by_name}` : ""}
                </li>
                {load.released_at ? (
                  <li>
                    <span className="text-muted-foreground">Orden de carga emitida</span> el {formatDateTime(load.released_at)}
                  </li>
                ) : null}
                {load.loaded_at ? (
                  <li>
                    <span className="text-muted-foreground">Cargada</span> el {formatDateTime(load.loaded_at)}
                    {load.loaded_by_name ? ` por ${load.loaded_by_name}` : ""}
                  </li>
                ) : null}
                {load.delivered_at ? (
                  <li>
                    <span className="text-muted-foreground">Entregada</span> el {formatDateTime(load.delivered_at)}
                  </li>
                ) : null}
                <li>
                  <span className="text-muted-foreground">Última modificación</span> el {formatDateTime(load.updated_at)}
                </li>
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={dialog === "release"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Emitir la carga ${load.number} a fábrica`}
        description="Pasa a «Lista para cargar» y se avisa a fábrica para que la pese. Ya no se podrá editar salvo que la devuelvas a planificación."
        confirmLabel="Emitir a fábrica"
        loading={transition.isPending}
        onConfirm={() => transition.mutate("release")}
      />
      <ConfirmDialog
        open={dialog === "unrelease"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Devolver la carga ${load.number} a planificación`}
        description="Vuelve a «Planificada» para poder editarla. Fábrica dejará de verla en las cargas por pesar."
        confirmLabel="Devolver a planificación"
        loading={transition.isPending}
        onConfirm={() => transition.mutate("unrelease")}
      />
      {dialog === "cancel" ? <CancelLoadDialog load={ref} onClose={() => setDialog(null)} /> : null}
      {delivering ? <DeliverDialog load={ref} stop={delivering} onClose={() => setDelivering(null)} /> : null}
    </>
  );
}

function StopRow({
  loadId,
  stop,
  canDeliver,
  onDeliver,
}: {
  loadId: string;
  stop: LoadStop;
  canDeliver: boolean;
  onDeliver: () => void;
}) {
  return (
    <li className="flex gap-3 rounded-lg border p-3" aria-label={`Parada ${stop.sequence}: ${stop.customer_name}`}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold tabular-nums">
        {stop.sequence}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p className="truncate font-medium">{stop.customer_name}</p>
          <span className="text-sm font-semibold tabular-nums">{formatKg(stop.total_kg)}</span>
        </div>
        <p className="flex items-center gap-1 text-sm text-muted-foreground">
          <MapPin className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {stop.farm_name}
            {stop.farm_city ? ` · ${stop.farm_city}` : ""}
            {stop.farm_rega ? ` · REGA ${stop.farm_rega}` : ""}
          </span>
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <Link href={`/pedidos/${stop.order_id}`} className="inline-flex min-h-11 items-center text-link hover:underline md:min-h-0">
            Pedido {stop.order_number}
          </Link>
          <span className="text-muted-foreground">Entrega {formatPlainDate(stop.requested_date)}</span>
          {stop.delivery_note_number ? <span className="text-muted-foreground">Albarán {stop.delivery_note_number}</span> : null}
        </p>
        <div className="mt-2">
          {stop.delivered_at ? (
            <p className="flex items-start gap-1.5 text-sm text-success">
              <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                Entregado el {formatDateTime(stop.delivered_at)}
                {stop.received_by ? ` · recibió ${stop.received_by}` : ""}
                {stop.delivery_notes ? <span className="block text-muted-foreground">{stop.delivery_notes}</span> : null}
              </span>
            </p>
          ) : (
            <Badge variant="outline">Pendiente de entrega</Badge>
          )}
        </div>
        {hasDeliveryNote(stop) || canDeliver ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {hasDeliveryNote(stop) ? (
              <PdfButton
                size="sm"
                path={deliveryNotePath(loadId, stop.id)}
                filename={`${stop.delivery_note_number ?? "albaran"}.pdf`}
                label="Albarán (PDF)"
              />
            ) : null}
            {canDeliver ? (
              <Button size="sm" onClick={onDeliver}>
                <CircleCheck aria-hidden /> Confirmar entrega
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
