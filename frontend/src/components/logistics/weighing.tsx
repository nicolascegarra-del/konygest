"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Scale, TriangleAlert, Truck as TruckIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState, ErrorState, Field, FieldError, LoadingBlock, PageHeader } from "@/components/common/states";
import { KgInput } from "@/components/factory/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { optionLabel, useMasterLookups } from "@/hooks/use-master-lookups";
import { api } from "@/lib/api";
import { friendlyMessage, isApiError } from "@/lib/errors";
import { formatKg, formatPercent, formatPlainDate, numberToInput, parseDecimal, toIsoDate } from "@/lib/format";
import { netDifferencePct, netWeight, NET_TOLERANCE_PCT } from "@/lib/loads";
import { cn } from "@/lib/utils";
import type { Page } from "@/types/api";
import type { StockLevel } from "@/types/fase1";
import type { LoadDetail, LoadItem, LoadSummary, WeighingPayload } from "@/types/fase3";

import { BackLink, invalidateLogistics, loadDetailKey, LoadStatusBadge, PdfButton, plural } from "./common";
import { CompartmentsView, deliveryNotePath, hasDeliveryNote } from "./load-detail";
import { errorDetail } from "./load-form";

// ─── Lista: cargas por pesar ───────────────────────

/** `/fabrica/cargas`: cargas emitidas a fábrica (por pesar) y las ya cargadas hoy. */
export function WeighingListPage() {
  const today = toIsoDate();
  const ready = useQuery({
    queryKey: ["loads", "list", { status: "ready" }],
    queryFn: ({ signal }) => api.get<Page<LoadSummary>>("/loads", { status: "ready", limit: 50 }, signal),
  });
  const loaded = useQuery({
    queryKey: ["loads", "list", { status: "loaded", date: today }],
    queryFn: ({ signal }) => api.get<Page<LoadSummary>>("/loads", { status: "loaded", date: today, limit: 50 }, signal),
  });

  return (
    <>
      <PageHeader title="Cargas por pesar" description="Órdenes de carga emitidas por logística. Pesa el camión y registra los kilos reales." />
      <section aria-labelledby="ready-title" className="mb-6">
        <h2 id="ready-title" className="mb-3 text-lg font-semibold">
          Por pesar{ready.data ? ` (${ready.data.total})` : ""}
        </h2>
        {ready.isPending ? (
          <LoadingBlock rows={3} />
        ) : ready.isError ? (
          <ErrorState error={ready.error} onRetry={() => ready.refetch()} />
        ) : ready.data.items.length === 0 ? (
          <EmptyState title="No hay cargas por pesar" description="Cuando logística emita una orden de carga aparecerá aquí." />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {ready.data.items.map((load) => (
              <WeighingCard key={load.id} load={load} actionLabel="Registrar pesada" />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="loaded-title">
        <h2 id="loaded-title" className="mb-3 text-lg font-semibold">
          Cargadas hoy{loaded.data ? ` (${loaded.data.total})` : ""}
        </h2>
        {loaded.isPending ? (
          <LoadingBlock rows={2} />
        ) : loaded.isError ? (
          <ErrorState error={loaded.error} onRetry={() => loaded.refetch()} />
        ) : loaded.data.items.length === 0 ? (
          <EmptyState title="Ninguna carga pesada hoy" />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {loaded.data.items.map((load) => (
              <WeighingCard key={load.id} load={load} actionLabel="Ver pesada" />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function WeighingCard({ load, actionLabel }: { load: LoadSummary; actionLabel: string }) {
  return (
    <li className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-lg font-semibold">{load.truck_plate}</p>
          <p className="text-sm text-muted-foreground">
            {load.number} · {formatPlainDate(load.load_date)} · {load.driver_name ?? "sin conductor"}
          </p>
        </div>
        <LoadStatusBadge status={load.status} />
      </div>
      <p className="mt-2 text-sm">
        <span className="font-semibold tabular-nums">{formatKg(load.planned_kg)}</span>
        <span className="text-muted-foreground"> · {plural(load.stop_count, "parada", "paradas")}</span>
      </p>
      <p className="truncate text-sm text-muted-foreground">{load.customers.join(" → ")}</p>
      <Button asChild size="lg" className="mt-3 w-full" variant={load.status === "ready" ? "default" : "outline"}>
        <Link href={`/fabrica/cargas/${load.id}`}>
          {load.status === "ready" ? <Scale aria-hidden /> : <TruckIcon aria-hidden />} {actionLabel}
        </Link>
      </Button>
    </li>
  );
}

// ─── Pantalla de pesada ────────────────────────────

export interface WeighingRow {
  actual: string;
  /** `null` = sin tocar: se usa el silo sugerido (el único con stock de ese pienso), si lo hay. */
  silo: string | null;
  lot: string;
}

export type RowErrors = Record<string, { actual?: string; silo?: string }>;

/** Filas iniciales: kilos reales prefijados con los previstos. */
export function initialWeighingRows(items: LoadItem[]): Record<string, WeighingRow> {
  return Object.fromEntries(items.map((item) => [item.id, { actual: numberToInput(item.planned_kg), silo: null, lot: "" }]));
}

/** Silo sugerido para un pienso: el único silo con stock positivo; si hay varios o ninguno, ninguno. */
export function suggestedSilo(stockBySilo: Map<string, number> | undefined): string {
  if (!stockBySilo) return "";
  const withStock = [...stockBySilo.entries()].filter(([, kg]) => kg > 0);
  return withStock.length === 1 ? (withStock[0]?.[0] ?? "") : "";
}

/** Valida la pesada; devuelve los errores por `load_item` (vacío si está todo bien). */
export function validateWeighing(items: LoadItem[], rows: Record<string, WeighingRow>, siloOf: (item: LoadItem) => string): RowErrors {
  const errors: RowErrors = {};
  for (const item of items) {
    const row = rows[item.id];
    const actual = parseDecimal(row?.actual ?? "");
    const entry: { actual?: string; silo?: string } = {};
    if (actual === null || actual <= 0) entry.actual = "Indica los kilos reales (mayor que 0).";
    if (!siloOf(item)) entry.silo = "Elige el silo del que sale el pienso.";
    if (entry.actual || entry.silo) errors[item.id] = entry;
  }
  return errors;
}

/** Cuerpo de `POST /loads/{id}/load`: un elemento por compartimento; bruto y tara solo si se han indicado. */
export function buildWeighingPayload(
  items: LoadItem[],
  rows: Record<string, WeighingRow>,
  siloOf: (item: LoadItem) => string,
  grossKg: number | null,
  tareKg: number | null,
): WeighingPayload {
  const payload: WeighingPayload = {
    items: items.map((item) => {
      const row = rows[item.id];
      const lot = row?.lot.trim() ?? "";
      return { item_id: item.id, actual_kg: parseDecimal(row?.actual ?? "") ?? 0, silo_id: siloOf(item), lot: lot || null };
    }),
  };
  if (grossKg !== null) payload.gross_kg = grossKg;
  if (tareKg !== null) payload.tare_kg = tareKg;
  return payload;
}

/** `/fabrica/cargas/[id]`: registro de la pesada (o la pesada ya registrada, en solo lectura). */
export function WeighingPage({ loadId }: { loadId: string }) {
  const query = useQuery({
    queryKey: loadDetailKey(loadId),
    queryFn: ({ signal }) => api.get<LoadDetail>(`/loads/${loadId}`, undefined, signal),
  });

  if (query.isPending) return <LoadingBlock rows={6} />;
  if (query.isError) {
    return (
      <>
        <BackLink href="/fabrica/cargas" label="Cargas por pesar" />
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      </>
    );
  }
  const load = query.data;
  const canWeigh = load.status === "ready" && load.allowed_actions.includes("load");
  return (
    <>
      <BackLink href="/fabrica/cargas" label="Cargas por pesar" />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
          {load.truck_plate} · {load.number}
        </h1>
        <LoadStatusBadge status={load.status} />
      </div>
      <p className="-mt-2 mb-4 text-sm text-muted-foreground">
        {formatPlainDate(load.load_date)} · {load.driver_name ?? "sin conductor"} · {plural(load.stop_count, "parada", "paradas")}
      </p>
      {canWeigh ? <WeighingForm load={load} /> : <WeighingReadOnly load={load} />}
    </>
  );
}

function DeliveryNotes({ load }: { load: LoadDetail }) {
  const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence).filter(hasDeliveryNote);
  if (stops.length === 0) return null;
  return (
    <ul className="space-y-2">
      {stops.map((stop) => (
        <li key={stop.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
          <span className="min-w-0">
            <span className="font-medium">
              {stop.sequence}. {stop.customer_name}
            </span>
            <span className="block text-xs text-muted-foreground">Albarán {stop.delivery_note_number}</span>
          </span>
          <PdfButton path={deliveryNotePath(load.id, stop.id)} filename={`${stop.delivery_note_number ?? "albaran"}.pdf`} label="Albarán (PDF)" />
        </li>
      ))}
    </ul>
  );
}

function WeighingReadOnly({ load }: { load: LoadDetail }) {
  const message =
    load.status === "planned"
      ? "Logística todavía no ha emitido esta carga a fábrica."
      : load.status === "cancelled"
        ? "Esta carga está cancelada."
        : load.status === "ready"
          ? "No tienes permiso para registrar la pesada."
          : "La pesada ya está registrada.";
  return (
    <div className="space-y-4">
      <p className="rounded-lg bg-muted p-3 text-sm">{message}</p>
      <Card>
        <CardHeader>
          <CardTitle>Compartimentos</CardTitle>
        </CardHeader>
        <CardContent>
          <CompartmentsView load={load} />
        </CardContent>
      </Card>
      {load.stops.some(hasDeliveryNote) ? (
        <Card>
          <CardHeader>
            <CardTitle>Albaranes</CardTitle>
          </CardHeader>
          <CardContent>
            <DeliveryNotes load={load} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/** Formulario de pesada: un bloque por compartimento, pensado para la tablet junto a la báscula. */
export function WeighingForm({ load }: { load: LoadDetail }) {
  const queryClient = useQueryClient();
  const lookups = useMasterLookups();
  const items = [...load.items].sort((a, b) => a.compartment - b.compartment);
  const stops = new Map(load.stops.map((stop) => [stop.id, stop]));
  const [rows, setRows] = useState<Record<string, WeighingRow>>(() => initialWeighingRows(items));
  const [gross, setGross] = useState("");
  const [tare, setTare] = useState("");
  const [errors, setErrors] = useState<RowErrors>({});
  const [scaleError, setScaleError] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ message: string; detail?: string | null } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<LoadDetail | null>(null);

  const itemIds = [...new Set(items.map((item) => item.item_id))];
  const stockQueries = useQueries({
    queries: itemIds.map((itemId) => ({
      queryKey: ["stock", "levels", { item_id: itemId }],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.get<Page<StockLevel>>("/stock/levels", { item_id: itemId, limit: 200 }, signal),
    })),
  });
  const stockByItem = new Map<string, Map<string, number>>();
  itemIds.forEach((itemId, index) => {
    const data = stockQueries[index]?.data;
    if (data) stockByItem.set(itemId, new Map(data.items.map((level) => [level.silo_id, level.quantity_kg])));
  });

  const siloOf = (item: LoadItem) => {
    const row = rows[item.id];
    if (row && row.silo !== null) return row.silo;
    return suggestedSilo(stockByItem.get(item.item_id));
  };
  const silos = lookups.data?.silos ?? [];

  const setRow = (id: string, patch: Partial<WeighingRow>) => {
    setRows((current) => ({ ...current, [id]: { ...(current[id] ?? { actual: "", silo: null, lot: "" }), ...patch } }));
    setErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setProblem(null);
  };

  const grossKg = parseDecimal(gross);
  const tareKg = parseDecimal(tare);
  const net = netWeight(grossKg, tareKg);
  const sumActual = items.reduce((sum, item) => sum + (parseDecimal(rows[item.id]?.actual ?? "") ?? 0), 0);
  const sumPlanned = items.reduce((sum, item) => sum + item.planned_kg, 0);
  const netDiff = net !== null && sumActual > 0 ? netDifferencePct(net, sumActual) : 0;

  // Kilos que se piden a cada silo de cada pienso (varios compartimentos pueden salir del mismo).
  const requested = new Map<string, number>();
  for (const item of items) {
    const silo = siloOf(item);
    if (!silo) continue;
    const key = `${item.item_id}|${silo}`;
    requested.set(key, (requested.get(key) ?? 0) + (parseDecimal(rows[item.id]?.actual ?? "") ?? 0));
  }

  const mutation = useMutation({
    mutationFn: (payload: WeighingPayload) => api.post<LoadDetail>(`/loads/${load.id}/load`, payload),
    onSuccess: (saved) => {
      toast.success(`Carga ${saved.number} registrada. Ya está en ruta.`);
      invalidateLogistics(queryClient, { stock: true });
      setConfirming(false);
      setResult(saved);
    },
    onError: (error) => {
      setConfirming(false);
      const message = friendlyMessage(error);
      const detail = errorDetail(error) ?? (isApiError(error, "INSUFFICIENT_STOCK") && error.message !== message ? error.message : null);
      const match = isApiError(error) && error.field ? /^items\.(\d+)(?:\.(\w+))?$/.exec(error.field) : null;
      const target = match ? items[Number(match[1])] : undefined;
      if (target) {
        const key = match?.[2] === "actual_kg" ? "actual" : "silo";
        setErrors({ [target.id]: { [key]: detail ?? message } });
      }
      if (isApiError(error) && (error.field === "gross_kg" || error.field === "tare_kg")) setScaleError(message);
      setProblem({ message, detail });
      toast.error(message);
    },
  });

  const review = () => {
    const nextErrors = validateWeighing(items, rows, siloOf);
    setErrors(nextErrors);
    let scale: string | null = null;
    if (gross.trim() && grossKg === null) scale = "El bruto no es un número válido.";
    else if (tare.trim() && tareKg === null) scale = "La tara no es un número válido.";
    else if (grossKg !== null && tareKg !== null && grossKg <= tareKg) scale = "El bruto debe ser mayor que la tara.";
    setScaleError(scale);
    if (Object.keys(nextErrors).length || scale) {
      setProblem({ message: "Revisa los campos marcados." });
      return;
    }
    setProblem(null);
    setConfirming(true);
  };

  if (result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CircleCheck className="size-5 text-success" aria-hidden /> Carga registrada
          </CardTitle>
          <CardDescription>
            Se ha descontado el stock y se han emitido los albaranes. Imprímelos para el conductor.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <DeliveryNotes load={result} />
          {!result.stops.some(hasDeliveryNote) ? (
            <p className="text-sm text-muted-foreground">Los albaranes aparecerán en la ficha de la carga.</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link href={`/logistica/cargas/${result.id}`}>Ver la carga</Link>
            </Button>
            <Button asChild>
              <Link href="/fabrica/cargas">Volver a cargas por pesar</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4 pb-24">
      <ul className="space-y-3">
        {items.map((item) => {
          const stop = stops.get(item.stop_id);
          const row = rows[item.id] ?? { actual: "", silo: null, lot: "" };
          const silo = siloOf(item);
          const stock = stockByItem.get(item.item_id);
          const available = silo && stock ? (stock.get(silo) ?? 0) : null;
          const asked = silo ? (requested.get(`${item.item_id}|${silo}`) ?? 0) : 0;
          const rowErrors = errors[item.id] ?? {};
          const capacity = load.compartments[item.compartment - 1] ?? 0;
          const actual = parseDecimal(row.actual);
          return (
            <li key={item.id} className={cn("rounded-lg border bg-card p-4 shadow-sm", (rowErrors.actual || rowErrors.silo) && "border-destructive")}>
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground">Compartimento {item.compartment}</p>
                  <p className="text-lg font-semibold">
                    {item.item_code} · {item.item_name}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {stop ? `${stop.sequence}. ${stop.customer_name}` : ""}
                    {item.farm_silo ? ` → ${item.farm_silo}` : ""}
                  </p>
                </div>
                <p className="text-right text-sm">
                  <span className="block text-muted-foreground">Previsto</span>
                  <span className="text-lg font-semibold tabular-nums">{formatKg(item.planned_kg)}</span>
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="Kg reales *" htmlFor={`actual-${item.id}`} error={rowErrors.actual}>
                  <KgInput
                    id={`actual-${item.id}`}
                    className="text-lg"
                    value={row.actual}
                    aria-invalid={rowErrors.actual ? true : undefined}
                    onChange={(event) => setRow(item.id, { actual: event.target.value })}
                  />
                  {actual !== null && actual > capacity && capacity > 0 ? (
                    <p className="mt-1 text-xs font-medium text-warning">Supera la capacidad del compartimento ({formatKg(capacity)}).</p>
                  ) : null}
                </Field>
                <Field label="Silo de origen *" htmlFor={`silo-${item.id}`} error={rowErrors.silo}>
                  <Select
                    id={`silo-${item.id}`}
                    value={silo}
                    aria-invalid={rowErrors.silo ? true : undefined}
                    onChange={(event) => setRow(item.id, { silo: event.target.value })}
                  >
                    <option value="">{lookups.isPending ? "Cargando…" : "Elige el silo"}</option>
                    {silos.map((option) => {
                      const kg = stock?.get(option.id);
                      return (
                        <option key={option.id} value={option.id}>
                          {optionLabel(option)}
                          {stock ? ` — ${kg && kg > 0 ? `${formatKg(kg)} disponibles` : "sin stock"}` : ""}
                        </option>
                      );
                    })}
                  </Select>
                  {available !== null && asked > available ? (
                    <p className="mt-1 flex items-center gap-1 text-xs font-medium text-warning">
                      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                      Ese silo solo tiene {formatKg(available)} de este pienso.
                    </p>
                  ) : null}
                </Field>
                <Field label="Lote" htmlFor={`lot-${item.id}`} hint="Opcional.">
                  <Input
                    id={`lot-${item.id}`}
                    value={row.lot}
                    maxLength={50}
                    autoComplete="off"
                    onChange={(event) => setRow(item.id, { lot: event.target.value })}
                  />
                </Field>
              </div>
            </li>
          );
        })}
      </ul>

      <Card>
        <CardHeader>
          <CardTitle>Báscula</CardTitle>
          <CardDescription>Opcional: bruto y tara del camión. El neto se compara con la suma de compartimentos.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Bruto" htmlFor="weigh-gross">
              <KgInput id="weigh-gross" value={gross} aria-invalid={scaleError ? true : undefined} onChange={(event) => setGross(event.target.value)} />
            </Field>
            <Field label="Tara" htmlFor="weigh-tare">
              <KgInput id="weigh-tare" value={tare} aria-invalid={scaleError ? true : undefined} onChange={(event) => setTare(event.target.value)} />
            </Field>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Neto</p>
              <p className="flex min-h-11 items-center text-lg font-semibold tabular-nums" aria-live="polite" data-testid="net-weight">
                {net !== null ? formatKg(net) : "—"}
              </p>
            </div>
          </div>
          <FieldError message={scaleError ?? undefined} />
          {net !== null && netDiff > NET_TOLERANCE_PCT ? (
            <div role="status" className="flex gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <p>
                El neto de báscula ({formatKg(net)}) difiere un {formatPercent(netDiff)} de la suma de compartimentos ({formatKg(sumActual)}).
                Revisa los kilos antes de registrar.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {problem ? (
        <div role="alert" className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
          <div>
            <p className="font-medium">{problem.message}</p>
            {problem.detail ? <p className="mt-1 text-muted-foreground">{problem.detail}</p> : null}
          </div>
        </div>
      ) : null}

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-3 backdrop-blur md:sticky md:rounded-lg md:border">
        <div className="mx-auto flex max-w-screen-xl items-center justify-between gap-3">
          <p className="min-w-0 text-sm">
            <span className="font-semibold tabular-nums">{formatKg(sumActual)}</span>
            <span className="text-muted-foreground"> reales de {formatKg(sumPlanned)} previstos</span>
          </p>
          <Button size="lg" onClick={review}>
            <Scale aria-hidden /> Registrar carga
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
        title={`Registrar la carga ${load.number}`}
        description={`Saldrán ${formatKg(sumActual)} de los silos elegidos y se emitirán los albaranes de ${plural(load.stops.length, "parada", "paradas")}. No se puede deshacer.`}
        confirmLabel="Registrar carga"
        loading={mutation.isPending}
        onConfirm={() => mutation.mutate(buildWeighingPayload(items, rows, siloOf, grossKg, tareKg))}
      />
    </div>
  );
}
