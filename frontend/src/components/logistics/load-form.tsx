"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, TriangleAlert, Wand2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch, type Path } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { EmptyState, ErrorState, Field, FieldError, LoadingBlock } from "@/components/common/states";
import { KgInput, Tabs } from "@/components/factory/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select, Textarea } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api } from "@/lib/api";
import { ApiError, friendlyMessage, isApiError } from "@/lib/errors";
import { formatKg, formatPlainDate, numberToInput, parseDecimal, toIsoDate } from "@/lib/format";
import { autoAllocate, sameAllocation, validateManualAllocation, type ManualAssignment } from "@/lib/loads";
import { cn } from "@/lib/utils";
import type { Page } from "@/types/api";
import type { Truck } from "@/types/fase1";
import type { LoadDetail, LoadItemPayload, LoadPayload, PendingOrder } from "@/types/fase3";

import { invalidateLogistics, OccupancyBar, plural, shiftIsoDate, useDrivers, useTrucks } from "./common";

const MAX_STOPS = 10;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Códigos en los que el mensaje del servidor añade el detalle (kg que faltan, qué línea...). */
const DETAILED_CODES = new Set(["LOAD_DOES_NOT_FIT", "COMPARTMENT_OVERFLOW", "ORDER_NOT_PLANNABLE", "INSUFFICIENT_STOCK"]);

/** Línea de un pedido de la carga, tal y como se reparte. */
export interface CandidateLine {
  id: string;
  item_code: string;
  item_name: string;
  quantity_kg: number;
  farm_silo: string;
}

/** Pedido que va (o puede ir) en la carga: viene de los pendientes o de las paradas guardadas. */
export interface CandidateOrder {
  order_id: string;
  order_number: string;
  customer_name: string;
  farm_name: string;
  farm_city: string;
  requested_date: string;
  total_kg: number;
  lines: CandidateLine[];
}

export function candidateFromPending(order: PendingOrder): CandidateOrder {
  return {
    order_id: order.id,
    order_number: order.number,
    customer_name: order.customer_name,
    farm_name: order.farm_name,
    farm_city: order.farm_city,
    requested_date: order.requested_date,
    total_kg: order.total_kg,
    lines: order.lines.map((line) => ({
      id: line.id,
      item_code: line.item_code,
      item_name: line.item_name,
      quantity_kg: line.quantity_kg,
      farm_silo: line.farm_silo,
    })),
  };
}

/**
 * Paradas de una carga guardada como pedidos del formulario. Las líneas se reconstruyen con el
 * reparto (los pedidos no se parten entre cargas: la suma por línea es su cantidad).
 */
export function candidatesFromLoad(load: LoadDetail): CandidateOrder[] {
  return [...load.stops]
    .sort((a, b) => a.sequence - b.sequence)
    .map((stop) => {
      const lines = new Map<string, CandidateLine>();
      for (const item of [...load.items].sort((a, b) => a.compartment - b.compartment)) {
        if (item.stop_id !== stop.id) continue;
        const line = lines.get(item.order_line_id);
        if (line) {
          line.quantity_kg = Math.round((line.quantity_kg + item.planned_kg) * 100) / 100;
        } else {
          lines.set(item.order_line_id, {
            id: item.order_line_id,
            item_code: item.item_code,
            item_name: item.item_name,
            quantity_kg: item.planned_kg,
            farm_silo: item.farm_silo,
          });
        }
      }
      return {
        order_id: stop.order_id,
        order_number: stop.order_number,
        customer_name: stop.customer_name,
        farm_name: stop.farm_name,
        farm_city: stop.farm_city,
        requested_date: stop.requested_date,
        total_kg: stop.total_kg,
        lines: [...lines.values()],
      };
    });
}

export function buildLoadSchema(today: string) {
  return z.object({
    load_date: z
      .string()
      .regex(ISO_DATE, "Indica la fecha de la carga.")
      .refine((value) => value >= today, "La fecha de la carga no puede ser anterior a hoy."),
    truck_id: z.string().min(1, "Elige el camión."),
    driver_id: z.string(),
    notes: z.string().trim().max(2000, "Como máximo 2000 caracteres."),
  });
}

type HeaderInput = z.input<ReturnType<typeof buildLoadSchema>>;
type HeaderOutput = z.output<ReturnType<typeof buildLoadSchema>>;

/** Cuerpo para la API. Sin `items` (reparto automático) salvo que se reparta a mano. */
export function buildLoadPayload(header: HeaderOutput, stops: CandidateOrder[], items: LoadItemPayload[] | null): LoadPayload {
  const payload: LoadPayload = {
    load_date: header.load_date,
    truck_id: header.truck_id,
    driver_id: header.driver_id || null,
    notes: header.notes,
    stops: stops.map((stop, index) => ({ order_id: stop.order_id, sequence: index + 1 })),
  };
  if (items) payload.items = items;
  return payload;
}

const HEADER_FIELDS = new Set(["load_date", "truck_id", "driver_id", "notes"]);

export type LoadFieldTarget =
  | { kind: "header"; name: Path<HeaderInput> }
  | { kind: "stop"; index: number }
  | { kind: "item"; index: number };

/** Traduce el `field` de un error de la API (`stops.1.order_id`, `items.3`...) a una parte del formulario. */
export function loadFieldFromApi(field: string | null): LoadFieldTarget | null {
  if (!field) return null;
  if (HEADER_FIELDS.has(field)) return { kind: "header", name: field as Path<HeaderInput> };
  const stop = /^stops\.(\d+)(?:\.\w+)?$/.exec(field);
  if (stop) return { kind: "stop", index: Number(stop[1]) };
  const item = /^items\.(\d+)(?:\.\w+)?$/.exec(field);
  if (item) return { kind: "item", index: Number(item[1]) };
  return null;
}

/** Mensaje del servidor con el detalle, cuando aporta algo al mensaje amable. */
export function errorDetail(error: unknown): string | null {
  if (!(error instanceof ApiError) || !DETAILED_CODES.has(error.code)) return null;
  return error.message && error.message !== friendlyMessage(error) ? error.message : null;
}

type ManualRow = { lineId: string; kg: string };

function manualFromItems(items: LoadItemPayload[], compartments: number): ManualRow[] {
  const rows: ManualRow[] = Array.from({ length: compartments }, () => ({ lineId: "", kg: "" }));
  for (const item of items) {
    if (item.compartment >= 1 && item.compartment <= compartments) {
      rows[item.compartment - 1] = { lineId: item.order_line_id, kg: numberToInput(item.planned_kg) };
    }
  }
  return rows;
}

function toAllocStops(stops: CandidateOrder[]) {
  return stops.map((stop) => ({ order_id: stop.order_id, lines: stop.lines }));
}

interface FormProblem {
  message: string;
  detail?: string | null;
}

/**
 * Formulario de carga (alta y edición): datos, paradas con su orden de descarga y reparto en
 * compartimentos (automático, como el servidor, o a mano).
 */
export function LoadForm({
  load = null,
  initialDate,
  initialOrderIds = [],
}: {
  load?: LoadDetail | null;
  initialDate?: string;
  initialOrderIds?: string[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const today = toIsoDate();
  const schema = useMemo(() => buildLoadSchema(today), [today]);
  const trucks = useTrucks();
  const drivers = useDrivers();

  const initialStops = useMemo(() => (load ? candidatesFromLoad(load) : []), [load]);
  const initialMode = useMemo<"auto" | "manual">(() => {
    if (!load) return "auto";
    const auto = autoAllocate(load.compartments, toAllocStops(initialStops));
    const saved = load.items.map((item) => ({ order_line_id: item.order_line_id, compartment: item.compartment, planned_kg: item.planned_kg }));
    return sameAllocation(auto.items, saved) ? "auto" : "manual";
  }, [load, initialStops]);

  const [stops, setStops] = useState<CandidateOrder[]>(initialStops);
  const [mode, setMode] = useState<"auto" | "manual">(initialMode);
  const [manual, setManual] = useState<ManualRow[]>(() =>
    load && initialMode === "manual" ? manualFromItems(load.items, load.compartments.length) : [],
  );
  const [stopErrors, setStopErrors] = useState<Record<string, string>>({});
  const [itemErrors, setItemErrors] = useState<Record<number, string>>({});
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim());

  const {
    control,
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<HeaderInput, unknown, HeaderOutput>({
    resolver: zodResolver(schema),
    defaultValues: load
      ? { load_date: load.load_date.slice(0, 10), truck_id: load.truck_id, driver_id: load.driver_id ?? "", notes: load.notes }
      : { load_date: initialDate && ISO_DATE.test(initialDate) && initialDate >= today ? initialDate : today, truck_id: "", driver_id: "", notes: "" },
  });
  const loadDate = useWatch({ control, name: "load_date" });
  const truckId = useWatch({ control, name: "truck_id" });

  const truckOptions = useMemo(() => {
    const list = trucks.data?.items ?? [];
    // Al editar, el camión guardado puede estar ya de baja: se mantiene como opción.
    if (load && !list.some((truck) => truck.id === load.truck_id)) {
      const current: Truck = {
        id: load.truck_id,
        plate: load.truck_plate,
        carrier_id: null,
        carrier_name: load.carrier_name,
        compartments: load.compartments,
        capacity_kg: load.capacity_kg,
        notes: "",
        is_active: false,
        created_at: load.created_at,
      };
      return [current, ...list];
    }
    return list;
  }, [trucks.data, load]);
  const truck = truckOptions.find((option) => option.id === truckId) ?? null;
  const compartments = useMemo(() => truck?.compartments ?? [], [truck]);
  const capacityKg = truck?.capacity_kg ?? compartments.reduce((sum, value) => sum + value, 0);

  const pendingDateTo = shiftIsoDate(ISO_DATE.test(loadDate ?? "") ? loadDate : today, 7);
  const pending = useQuery({
    queryKey: ["logistics", "pending", { date_to: pendingDateTo, search: debouncedSearch }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<Page<PendingOrder>>("/logistics/pending-orders", { date_to: pendingDateTo, search: debouncedSearch, limit: 100 }, signal),
  });

  // Pedidos elegidos en el tablero («Añadir a una carga nueva»): se añaden una sola vez al llegar la lista.
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || load || initialOrderIds.length === 0 || !pending.data) return;
    preselected.current = true;
    const byId = new Map(pending.data.items.map((order) => [order.id, order]));
    const found = initialOrderIds.map((id) => byId.get(id)).filter((order): order is PendingOrder => !!order);
    if (found.length) setStops(found.slice(0, MAX_STOPS).map(candidateFromPending));
    if (found.length < initialOrderIds.length) {
      toast.warning("Algún pedido elegido ya no está pendiente de planificar.");
    }
  }, [pending.data, initialOrderIds, load]);

  const allLines = stops.flatMap((stop, index) => stop.lines.map((line) => ({ ...line, stopIndex: index, stop })));
  const totalKg = stops.reduce((sum, stop) => sum + stop.lines.reduce((acc, line) => acc + line.quantity_kg, 0), 0);
  const auto = autoAllocate(compartments, toAllocStops(stops));
  const manualRows: ManualRow[] = compartments.map((_, index) => manual[index] ?? { lineId: "", kg: "" });
  const manualAssignments: ManualAssignment[] = manualRows.map((row) => ({ lineId: row.lineId, kg: parseDecimal(row.kg) }));
  const manualCheck = validateManualAllocation(compartments, allLines, manualAssignments, formatKg);
  const lineLabel = (lineId: string) => {
    const line = allLines.find((candidate) => candidate.id === lineId);
    return line ? `${line.stopIndex + 1}. ${line.stop.customer_name} — ${line.item_code} ${line.item_name}` : "";
  };

  const clearServerErrors = () => {
    setStopErrors({});
    setItemErrors({});
    setProblem(null);
  };

  const addStop = (order: PendingOrder) => {
    if (stops.length >= MAX_STOPS) {
      toast.error(`Como máximo ${MAX_STOPS} paradas por carga.`);
      return;
    }
    setStops((current) => [...current, candidateFromPending(order)]);
    clearServerErrors();
  };
  const removeStop = (orderId: string) => {
    const removed = new Set(stops.find((stop) => stop.order_id === orderId)?.lines.map((line) => line.id) ?? []);
    setStops((current) => current.filter((stop) => stop.order_id !== orderId));
    setManual((current) => current.map((row) => (removed.has(row.lineId) ? { lineId: "", kg: "" } : row)));
    clearServerErrors();
  };
  const moveStop = (index: number, delta: -1 | 1) => {
    setStops((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(target, 0, moved);
      return next;
    });
    clearServerErrors();
  };

  const fillManualFromAuto = (forCompartments: number[] = compartments) => {
    setManual(manualFromItems(autoAllocate(forCompartments, toAllocStops(stops)).items, forCompartments.length));
    setItemErrors({});
  };
  const changeMode = (next: "auto" | "manual") => {
    if (next === "manual" && manual.length === 0) fillManualFromAuto();
    setMode(next);
    setItemErrors({});
    setProblem(null);
  };
  const setManualRow = (index: number, patch: Partial<ManualRow>) => {
    setManual(() => {
      const next = [...manualRows];
      next[index] = { ...(next[index] ?? { lineId: "", kg: "" }), ...patch };
      return next;
    });
    setItemErrors((current) => {
      const rest = { ...current };
      delete rest[index];
      return rest;
    });
  };

  const truckField = register("truck_id", {
    onChange: (event: { target: { value: string } }) => {
      const next = truckOptions.find((option) => option.id === event.target.value);
      // Con otro camión cambian los compartimentos: el reparto a mano se rehace desde el automático.
      if (mode === "manual") fillManualFromAuto(next?.compartments ?? []);
      setItemErrors({});
    },
  });

  const save = useMutation({
    mutationFn: ({ payload }: { payload: LoadPayload; sentItems: LoadItemPayload[] | null }) =>
      load ? api.put<LoadDetail>(`/loads/${load.id}`, payload) : api.post<LoadDetail>("/loads", payload),
    onSuccess: (saved) => {
      toast.success(load ? `Carga ${saved.number} guardada.` : `Carga ${saved.number} creada.`);
      invalidateLogistics(queryClient);
      router.push(`/logistica/cargas/${saved.id}`);
    },
    onError: (error, { sentItems }) => {
      const message = friendlyMessage(error);
      const detail = errorDetail(error);
      const target = isApiError(error) ? loadFieldFromApi(error.field) : null;
      if (target?.kind === "header") {
        setError(target.name, { type: "server", message: detail ?? message });
        try {
          setFocus(target.name);
        } catch {
          // Algunos campos no exponen ref: basta con el mensaje.
        }
      } else if (target?.kind === "stop" && stops[target.index]) {
        setStopErrors({ [stops[target.index]!.order_id]: detail ?? message });
        setProblem({ message, detail });
      } else if (target?.kind === "item" && sentItems?.[target.index]) {
        setItemErrors({ [sentItems[target.index]!.compartment - 1]: detail ?? message });
        setProblem({ message, detail });
      } else {
        setProblem({ message, detail });
      }
      toast.error(message);
    },
  });

  const submit = handleSubmit(
    (header) => {
      clearServerErrors();
      if (stops.length === 0) {
        setProblem({ message: "Añade al menos un pedido a la carga." });
        return;
      }
      let items: LoadItemPayload[] | null = null;
      if (mode === "auto") {
        if (!auto.fits) {
          setProblem({
            message: `No cabe todo en este camión: faltan ${formatKg(auto.missingKg)}.`,
            detail: "Quita algún pedido, cambia el orden o elige un camión con más compartimentos.",
          });
          return;
        }
      } else {
        if (!manualCheck.items) {
          setProblem({ message: "Revisa el reparto en compartimentos: hay errores marcados." });
          return;
        }
        items = manualCheck.items;
      }
      save.mutate({ payload: buildLoadPayload(header, stops, items), sentItems: items });
    },
    () => setProblem({ message: "Revisa los campos marcados." }),
  );

  const inLoad = new Set(stops.map((stop) => stop.order_id));
  const available = (pending.data?.items ?? []).filter((order) => !inLoad.has(order.id));

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="pb-24"
    >
      <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Datos de la carga</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field label="Fecha *" htmlFor="load-date" error={errors.load_date?.message}>
              <Input id="load-date" type="date" min={today} aria-invalid={errors.load_date ? true : undefined} {...register("load_date")} />
            </Field>
            <Field label="Camión *" htmlFor="load-truck" error={errors.truck_id?.message}>
              <Select id="load-truck" aria-invalid={errors.truck_id ? true : undefined} {...truckField}>
                <option value="">{trucks.isPending ? "Cargando…" : "Elige el camión"}</option>
                {truckOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.plate} — {formatKg(option.capacity_kg)} en {plural(option.compartments.length, "compartimento", "compartimentos")}
                    {option.carrier_name ? ` (${option.carrier_name})` : ""}
                  </option>
                ))}
              </Select>
              {trucks.isError ? <FieldError message={`No se pudieron cargar los camiones: ${friendlyMessage(trucks.error)}`} /> : null}
            </Field>
            <Field label="Conductor" htmlFor="load-driver" error={errors.driver_id?.message}>
              <Select id="load-driver" {...register("driver_id")}>
                <option value="">{drivers.isPending ? "Cargando…" : "Sin conductor asignado"}</option>
                {(drivers.data?.items ?? []).map((driver) => (
                  <option key={driver.id} value={driver.id}>
                    {driver.full_name}
                    {driver.carrier_name ? ` (${driver.carrier_name})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Notas" htmlFor="load-notes" error={errors.notes?.message}>
              <Textarea id="load-notes" className="min-h-11" {...register("notes")} />
            </Field>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Paradas ({stops.length})</CardTitle>
            <CardDescription>En el orden de descarga: la primera es la primera que se descarga.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {truck ? <OccupancyBar plannedKg={totalKg} capacityKg={capacityKg} /> : null}
            {stops.length === 0 ? (
              <EmptyState title="Sin pedidos" description="Añade pedidos confirmados desde la lista de pendientes." />
            ) : (
              <ol className="space-y-2">
                {stops.map((stop, index) => {
                  const late = !!loadDate && stop.requested_date.slice(0, 10) < loadDate;
                  const error = stopErrors[stop.order_id];
                  return (
                    <li
                      key={stop.order_id}
                      className={cn("flex gap-2 rounded-lg border p-3", error && "border-destructive")}
                      aria-label={`Parada ${index + 1}: ${stop.customer_name}`}
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold tabular-nums">
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-baseline justify-between gap-x-2">
                          <span className="truncate font-medium">{stop.customer_name}</span>
                          <span className="text-sm font-semibold tabular-nums">{formatKg(stop.total_kg)}</span>
                        </p>
                        <p className="truncate text-sm text-muted-foreground">
                          {stop.farm_name}
                          {stop.farm_city ? ` · ${stop.farm_city}` : ""}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {stop.order_number} ·{" "}
                          <span className={cn(late && "font-medium text-warning")}>
                            entrega {formatPlainDate(stop.requested_date)}
                            {late ? " (llegaría tarde)" : ""}
                          </span>
                        </p>
                        <ul className="mt-1 text-xs text-muted-foreground">
                          {stop.lines.map((line) => (
                            <li key={line.id} className="truncate">
                              {line.item_code} · {line.item_name} — {formatKg(line.quantity_kg)}
                              {line.farm_silo ? ` → ${line.farm_silo}` : ""}
                            </li>
                          ))}
                        </ul>
                        <FieldError message={error} />
                      </div>
                      <div className="flex shrink-0 flex-col gap-1 sm:flex-row sm:items-start">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Subir parada ${index + 1}`}
                          disabled={index === 0}
                          onClick={() => moveStop(index, -1)}
                        >
                          <ArrowUp aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Bajar parada ${index + 1}`}
                          disabled={index === stops.length - 1}
                          onClick={() => moveStop(index, 1)}
                        >
                          <ArrowDown aria-hidden />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label={`Quitar parada ${index + 1}`} onClick={() => removeStop(stop.order_id)}>
                          <X aria-hidden />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-start-3 lg:row-span-3 lg:row-start-1">
          <CardHeader>
            <CardTitle>Pedidos pendientes</CardTitle>
            <CardDescription>Confirmados sin carga, con entrega hasta el {formatPlainDate(pendingDateTo)}.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar por número o cliente"
              aria-label="Buscar pedidos pendientes"
            />
            {pending.isPending ? (
              <LoadingBlock rows={3} />
            ) : pending.isError ? (
              <ErrorState error={pending.error} onRetry={() => pending.refetch()} />
            ) : available.length === 0 ? (
              <EmptyState title="No hay más pedidos pendientes" description={debouncedSearch ? "Prueba con otra búsqueda." : undefined} />
            ) : (
              <ul className="space-y-2 lg:max-h-[70vh] lg:overflow-y-auto">
                {available.map((order) => {
                  const late = !!loadDate && order.requested_date.slice(0, 10) < loadDate;
                  return (
                    <li key={order.id} className={cn("flex items-start gap-2 rounded-lg border p-3", late && "border-warning/60 bg-warning/5")}>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{order.customer_name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {order.number} · {order.farm_name}
                          {order.farm_city ? ` · ${order.farm_city}` : ""}
                        </p>
                        <p className={cn("text-xs", late ? "font-medium text-warning" : "text-muted-foreground")}>
                          {late ? <TriangleAlert className="mr-1 inline size-3.5" aria-hidden /> : null}
                          Entrega {formatPlainDate(order.requested_date)} · {formatKg(order.total_kg)}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Añadir ${order.number} (${order.customer_name}) a la carga`}
                        disabled={stops.length >= MAX_STOPS}
                        onClick={() => addStop(order)}
                      >
                        <Plus aria-hidden /> Añadir
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Reparto en compartimentos</CardTitle>
            <CardDescription>Un compartimento lleva una sola línea de pedido; una línea puede ocupar varios.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs
              label="Modo de reparto"
              value={mode}
              onChange={changeMode}
              tabs={[
                { value: "auto", label: "Reparto automático" },
                { value: "manual", label: "Repartir a mano" },
              ]}
            />
            {!truck ? (
              <p className="text-sm text-muted-foreground">Elige el camión para ver sus compartimentos.</p>
            ) : compartments.length === 0 ? (
              <p className="text-sm text-muted-foreground">Este camión no tiene compartimentos definidos.</p>
            ) : mode === "auto" ? (
              <AutoPreview compartments={compartments} items={auto.items} lineLabel={lineLabel} missingKg={auto.missingKg} />
            ) : (
              <div className="space-y-3">
                <ul className="space-y-2">
                  {compartments.map((capacity, index) => {
                    const row = manualRows[index] ?? { lineId: "", kg: "" };
                    const error = itemErrors[index] ?? manualCheck.compartmentErrors[index];
                    const kg = parseDecimal(row.kg) ?? 0;
                    return (
                      <li key={index} className={cn("rounded-lg border p-3", error && "border-destructive")}>
                        <p className="mb-2 flex justify-between gap-2 text-sm">
                          <span className="font-medium">Compartimento {index + 1}</span>
                          <span className="tabular-nums text-muted-foreground">
                            {row.lineId ? `${formatKg(kg)} / ` : ""}
                            {formatKg(capacity)}
                          </span>
                        </p>
                        <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
                          <Select
                            aria-label={`Línea del compartimento ${index + 1}`}
                            value={row.lineId}
                            onChange={(event) => setManualRow(index, { lineId: event.target.value })}
                          >
                            <option value="">Vacío</option>
                            {allLines.map((line) => (
                              <option key={line.id} value={line.id}>
                                {lineLabel(line.id)} ({formatKg(line.quantity_kg)})
                              </option>
                            ))}
                          </Select>
                          <KgInput
                            aria-label={`Kilos del compartimento ${index + 1}`}
                            aria-invalid={error ? true : undefined}
                            value={row.kg}
                            disabled={!row.lineId}
                            onChange={(event) => setManualRow(index, { kg: event.target.value })}
                          />
                        </div>
                        <FieldError message={error} />
                      </li>
                    );
                  })}
                </ul>
                {allLines.length ? (
                  <div className="rounded-lg bg-muted p-3">
                    <p className="mb-1 text-sm font-medium">Kilos por línea</p>
                    <ul className="space-y-1 text-sm">
                      {allLines.map((line) => {
                        const lineError = manualCheck.lineErrors[line.id];
                        return (
                          <li key={line.id} className="flex flex-wrap justify-between gap-x-3">
                            <span className="min-w-0 truncate">{lineLabel(line.id)}</span>
                            <span className={cn("tabular-nums", lineError ? "font-medium text-destructive" : "text-success")}>
                              {formatKg(manualCheck.assignedByLine[line.id] ?? 0)} de {formatKg(line.quantity_kg)}
                              {lineError ? ` · ${lineError}` : " ✓"}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
                <Button variant="outline" onClick={() => fillManualFromAuto()}>
                  <Wand2 aria-hidden /> Rellenar como el automático
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {problem ? (
        <div role="alert" className="mt-4 flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
          <div>
            <p className="font-medium">{problem.message}</p>
            {problem.detail ? <p className="mt-1 text-muted-foreground">{problem.detail}</p> : null}
          </div>
        </div>
      ) : null}

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-3 backdrop-blur md:sticky md:mt-4 md:rounded-lg md:border">
        <div className="mx-auto flex max-w-screen-xl items-center justify-between gap-3">
          <p className="min-w-0 text-sm">
            <span className="font-semibold tabular-nums">{formatKg(totalKg)}</span>
            {truck ? <span className="text-muted-foreground"> de {formatKg(capacityKg)}</span> : null}
            <span className="text-muted-foreground"> · {plural(stops.length, "parada", "paradas")}</span>
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" asChild className="hidden sm:inline-flex">
              <Link href={load ? `/logistica/cargas/${load.id}` : "/logistica"}>Volver</Link>
            </Button>
            <Button type="submit" loading={save.isPending}>
              {load ? "Guardar carga" : "Crear carga"}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

function AutoPreview({
  compartments,
  items,
  lineLabel,
  missingKg,
}: {
  compartments: number[];
  items: LoadItemPayload[];
  lineLabel: (lineId: string) => string;
  missingKg: number;
}) {
  const byCompartment = new Map(items.map((item) => [item.compartment, item]));
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Vista previa: el servidor rellena los compartimentos en orden siguiendo las paradas.
      </p>
      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Vista previa del reparto">
        {compartments.map((capacity, index) => {
          const item = byCompartment.get(index + 1);
          return (
            <li key={index} className={cn("rounded-lg border p-3 text-sm", !item && "border-dashed text-muted-foreground")}>
              <p className="flex justify-between gap-2">
                <span className="font-medium">C{index + 1}</span>
                <span className="tabular-nums">
                  {item ? `${formatKg(item.planned_kg)} / ` : ""}
                  {formatKg(capacity)}
                </span>
              </p>
              <p className="truncate">{item ? lineLabel(item.order_line_id) : "Vacío"}</p>
            </li>
          );
        })}
      </ul>
      {missingKg > 0 ? (
        <div role="alert" className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <p>
            <span className="font-medium">No cabe todo: faltan {formatKg(missingKg)}.</span>{" "}
            <span className="text-muted-foreground">Un compartimento no mezcla líneas, así que puede sobrar sitio en alguno.</span>
          </p>
        </div>
      ) : null}
    </div>
  );
}
