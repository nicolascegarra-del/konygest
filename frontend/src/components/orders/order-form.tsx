"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Send, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Controller, useFieldArray, useForm, useWatch, type Path } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Field, FieldError } from "@/components/common/states";
import { KgInput } from "@/components/factory/common";
import { CustomerPicker } from "@/components/masters/customer-picker";
import { numberInput } from "@/components/masters/form-schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select, Textarea } from "@/components/ui/input";
import { optionLabel, useMasterLookups } from "@/hooks/use-master-lookups";
import { api } from "@/lib/api";
import { friendlyMessage, isApiError } from "@/lib/errors";
import { formatKg, formatMoney, formatPercent, formatPrice, numberToInput, parseDecimal, toIsoDate } from "@/lib/format";
import { useAuthStore } from "@/stores/auth-store";
import type { Page } from "@/types/api";
import type { Farm, PriceQuote, PriceSource } from "@/types/fase1";
import type { LinePriceSource, SalesOrderDetail, SalesOrderPayload } from "@/types/fase2";

import { invalidateOrders, lineAmount, priceDifferencePct, PriceSourceBadge, samePrice, tomorrow } from "./common";

const MAX_LINES = 20;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Origen del precio que se muestra en la línea: el de la consulta, el guardado o ninguno aún. */
type QuotedSource = PriceSource | LinePriceSource | null;

const lineSchema = z.object({
  /** Identificador local de la línea: las respuestas de precio llegan asíncronas y la línea puede moverse. */
  uid: z.string(),
  item_id: z.string().min(1, "Elige el pienso."),
  quantity_kg: numberInput({ required: true, positive: true }),
  unit_price: numberInput({ min: 0, decimals: 4 }),
  farm_silo: z.string(),
  notes: z.string().trim().max(500, "Como máximo 500 caracteres."),
  /** Precio que corresponde al cliente (para detectar el manual y avisar si queda por debajo). */
  reference_price: z.number().nullable(),
  price_source: z.custom<QuotedSource>(),
});

/** Esquema del pedido. `today` (YYYY-MM-DD) es el mínimo para la fecha de entrega. */
export function buildOrderSchema(today: string) {
  return z.object({
    customer_id: z.string().min(1, "Elige el cliente."),
    farm_id: z.string().min(1, "Elige la explotación."),
    requested_date: z
      .string()
      .regex(ISO_DATE, "Indica la fecha de entrega.")
      .refine((value) => value >= today, "La fecha de entrega no puede ser anterior a hoy."),
    sales_rep_id: z.string(),
    notes: z.string().trim().max(2000, "Como máximo 2000 caracteres."),
    lines: z
      .array(lineSchema)
      .min(1, "Añade al menos una línea.")
      .max(MAX_LINES, `Como máximo ${MAX_LINES} líneas.`)
      .superRefine((lines, ctx) => {
        // El backend no admite dos líneas con el mismo pienso y el mismo silo de destino.
        const seen = new Set<string>();
        lines.forEach((line, index) => {
          if (!line.item_id) return;
          const key = `${line.item_id}|${line.farm_silo}`;
          if (seen.has(key)) {
            ctx.addIssue({
              code: "custom",
              path: [index, "item_id"],
              message: line.farm_silo ? "Este pienso ya va a ese silo en otra línea." : "Este pienso ya está en otra línea sin silo.",
            });
          }
          seen.add(key);
        });
      }),
  });
}

type OrderSchema = ReturnType<typeof buildOrderSchema>;
type OrderInput = z.input<OrderSchema>;
type OrderOutput = z.output<OrderSchema>;
type LineInput = OrderInput["lines"][number];

let uidSequence = 0;
const nextUid = () => `line-${++uidSequence}`;

function emptyLine(): LineInput {
  return {
    uid: nextUid(),
    item_id: "",
    quantity_kg: "",
    unit_price: "",
    farm_silo: "",
    notes: "",
    reference_price: null,
    price_source: null,
  };
}

/** ¿Ha cambiado el usuario el precio que le correspondía? (lo que el backend marcará como «manual»). */
export function isManualPrice(line: Pick<LineInput, "unit_price" | "reference_price">): boolean {
  const price = parseDecimal(line.unit_price);
  return price !== null && !samePrice(price, line.reference_price);
}

/**
 * Cuerpo para la API. El precio se envía tal y como se ve (el backend detecta si coincide con el
 * del cliente y entonces conserva su origen); vacío → `null`, y el backend aplica el del cliente.
 */
export function buildOrderPayload(values: OrderOutput, submit: boolean, includeSalesRep: boolean): SalesOrderPayload {
  const payload: SalesOrderPayload = {
    customer_id: values.customer_id,
    farm_id: values.farm_id,
    requested_date: values.requested_date,
    notes: values.notes,
    submit,
    lines: values.lines.map((line) => ({
      item_id: line.item_id,
      quantity_kg: line.quantity_kg ?? 0,
      unit_price: line.unit_price,
      ...(line.farm_silo ? { farm_silo: line.farm_silo } : {}),
      notes: line.notes,
    })),
  };
  if (includeSalesRep && values.sales_rep_id) payload.sales_rep_id = values.sales_rep_id;
  return payload;
}

function defaultValues(order: SalesOrderDetail | null): OrderInput {
  if (!order) {
    return {
      customer_id: "",
      farm_id: "",
      requested_date: toIsoDate(tomorrow()),
      sales_rep_id: "",
      notes: "",
      lines: [emptyLine()],
    };
  }
  return {
    customer_id: order.customer_id,
    farm_id: order.farm_id,
    requested_date: order.requested_date.slice(0, 10),
    sales_rep_id: order.sales_rep_id ?? "",
    notes: order.notes,
    lines: [...order.lines]
      .sort((a, b) => a.position - b.position)
      .map((line) => ({
        uid: nextUid(),
        item_id: line.item_id,
        quantity_kg: numberToInput(line.quantity_kg),
        unit_price: numberToInput(line.unit_price),
        farm_silo: line.farm_silo,
        notes: line.notes,
        reference_price: line.reference_price,
        price_source: line.price_source,
      })),
  };
}

const TOP_LEVEL_FIELDS = new Set(["customer_id", "farm_id", "requested_date", "sales_rep_id", "notes"]);
const LINE_FIELDS = new Set(["item_id", "quantity_kg", "unit_price", "farm_silo", "notes"]);

/** Traduce el `field` de un error de la API (`lines.2.unit_price`, `lines.1`…) a un campo del formulario. */
export function formFieldFromApi(field: string | null, lineCount: number): Path<OrderInput> | null {
  if (!field) return null;
  if (TOP_LEVEL_FIELDS.has(field)) return field as Path<OrderInput>;
  const match = /^lines\.(\d+)(?:\.(\w+))?$/.exec(field);
  if (!match) return null;
  const index = Number(match[1]);
  if (index >= lineCount) return null;
  const sub = match[2] ?? "item_id";
  return LINE_FIELDS.has(sub) ? (`lines.${index}.${sub}` as Path<OrderInput>) : null;
}

/**
 * Formulario de pedido (alta y edición). Pensado para el móvil del comercial: un bloque por línea,
 * precio prefijado según el cliente y totales siempre a la vista.
 */
export function OrderForm({ order = null }: { order?: SalesOrderDetail | null }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const lookups = useMasterLookups();
  const ownScope = useAuthStore((state) => state.user?.permissions["pedidos.crear"] === "own");
  const today = toIsoDate();
  const schema = useMemo(() => buildOrderSchema(today), [today]);
  const [quoting, setQuoting] = useState<Record<string, boolean>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const {
    control,
    register,
    handleSubmit,
    setValue,
    getValues,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<OrderInput, unknown, OrderOutput>({ resolver: zodResolver(schema), defaultValues: defaultValues(order) });
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const customerId = useWatch({ control, name: "customer_id" });
  const farmId = useWatch({ control, name: "farm_id" });
  const lines = useWatch({ control, name: "lines" });

  const farms = useQuery({
    queryKey: ["masters", "farms", "list", { customer_id: customerId, active: true }],
    enabled: !!customerId,
    queryFn: ({ signal }) =>
      api.get<Page<Farm>>("/masters/farms", { customer_id: customerId, active: true, limit: 200 }, signal),
  });
  const farmOptions = farms.data?.items ?? [];
  const selectedFarm = farmOptions.find((farm) => farm.id === farmId);
  const siloNames = selectedFarm?.silos.map((silo) => silo.name) ?? [];

  // Si el cliente solo tiene una explotación, se elige sola (el caso más habitual en el campo).
  useEffect(() => {
    const items = farms.data?.items;
    if (items && items.length === 1 && items[0] && !getValues("farm_id")) {
      setValue("farm_id", items[0].id, { shouldDirty: true });
    }
  }, [farms.data, getValues, setValue]);

  const lineIndex = (uid: string) => getValues("lines").findIndex((line) => line.uid === uid);

  /** Pide el precio del cliente para el pienso y lo prefija salvo que el usuario ya lo haya cambiado. */
  async function quotePrice(uid: string, itemId: string, forCustomer: string) {
    const index = lineIndex(uid);
    if (index < 0) return;
    if (!itemId || !forCustomer) {
      const current = getValues(`lines.${index}`);
      if (!isManualPrice(current)) setValue(`lines.${index}.unit_price`, "");
      setValue(`lines.${index}.reference_price`, null);
      setValue(`lines.${index}.price_source`, null);
      return;
    }
    setQuoting((state) => ({ ...state, [uid]: true }));
    try {
      const quote = await queryClient.fetchQuery({
        queryKey: ["masters", "customers", "price", forCustomer, itemId],
        staleTime: 60_000,
        queryFn: () => api.get<PriceQuote>(`/masters/customers/${forCustomer}/price`, { item_id: itemId }),
      });
      const at = lineIndex(uid);
      // La respuesta puede llegar tarde: solo vale si la línea sigue con ese pienso y ese cliente.
      if (at < 0 || getValues(`lines.${at}.item_id`) !== itemId || getValues("customer_id") !== forCustomer) return;
      const wasManual = isManualPrice(getValues(`lines.${at}`));
      setValue(`lines.${at}.reference_price`, quote.price);
      setValue(`lines.${at}.price_source`, quote.source);
      if (!wasManual) setValue(`lines.${at}.unit_price`, numberToInput(quote.price), { shouldDirty: true });
    } catch (error) {
      toast.error(`No se pudo consultar el precio: ${friendlyMessage(error)}`);
    } finally {
      setQuoting((state) => ({ ...state, [uid]: false }));
    }
  }

  function changeCustomer(nextCustomer: string) {
    setValue("customer_id", nextCustomer, { shouldDirty: true, shouldValidate: !!errors.customer_id });
    setValue("farm_id", "", { shouldDirty: true });
    getValues("lines").forEach((line, index) => {
      setValue(`lines.${index}.farm_silo`, "");
      void quotePrice(line.uid, line.item_id, nextCustomer);
    });
  }

  function changeFarm(nextFarm: string) {
    setValue("farm_id", nextFarm, { shouldDirty: true, shouldValidate: !!errors.farm_id });
    const silos = farmOptions.find((farm) => farm.id === nextFarm)?.silos.map((silo) => silo.name) ?? [];
    getValues("lines").forEach((line, index) => {
      if (line.farm_silo && !silos.includes(line.farm_silo)) setValue(`lines.${index}.farm_silo`, "");
    });
  }

  function changeItem(index: number, itemId: string) {
    setValue(`lines.${index}.item_id`, itemId, { shouldDirty: true, shouldValidate: !!errors.lines?.[index]?.item_id });
    const uid = getValues(`lines.${index}.uid`);
    void quotePrice(uid, itemId, getValues("customer_id"));
  }

  const save = useMutation({
    mutationFn: ({ values, submit }: { values: OrderOutput; submit: boolean }) => {
      const payload = buildOrderPayload(values, submit, !ownScope);
      return order
        ? api.put<SalesOrderDetail>(`/orders/${order.id}`, payload)
        : api.post<SalesOrderDetail>("/orders", payload);
    },
    onSuccess: (saved, { submit }) => {
      toast.success(submit ? `Pedido ${saved.number} enviado a validar.` : `Pedido ${saved.number} guardado.`);
      invalidateOrders(queryClient);
      router.push(`/pedidos/${saved.id}`);
    },
    onError: (error) => {
      const message = friendlyMessage(error);
      const path = isApiError(error) ? formFieldFromApi(error.field, getValues("lines").length) : null;
      if (path) {
        setError(path, { type: "server", message });
        setFormError(null);
        try {
          setFocus(path);
        } catch {
          // Algunos campos (selects controlados) no exponen ref: basta con el mensaje.
        }
      } else {
        setFormError(message);
      }
      toast.error(message);
    },
  });

  const send = (submit: boolean) =>
    handleSubmit(
      (values) => {
        setFormError(null);
        save.mutate({ values, submit });
      },
      () => setFormError("Revisa los campos marcados."),
    )();

  // Totales en vivo (mismo redondeo que el backend).
  let totalKg = 0;
  let totalAmount = 0;
  let missingPrice = false;
  for (const line of lines ?? []) {
    const kg = parseDecimal(line.quantity_kg ?? "");
    const price = parseDecimal(line.unit_price ?? "");
    if (kg !== null) totalKg += kg;
    const amount = lineAmount(kg, price);
    if (amount === null) {
      if (kg !== null) missingPrice = true;
    } else {
      totalAmount += amount;
    }
  }

  const products = (lookups.data?.items ?? []).filter((option) => option.kind === "product");
  const salesReps = lookups.data?.sales_reps ?? [];
  const canSubmit = !order || order.allowed_actions.includes("submit");
  const saveLabel = !order || order.status === "draft" ? "Guardar borrador" : order.status === "rejected" ? "Guardar sin enviar" : "Guardar cambios";
  const linesError = errors.lines?.message ?? errors.lines?.root?.message;

  return (
    <form onSubmit={(event) => event.preventDefault()} noValidate className="space-y-4 pb-4">
      <Card>
        <CardHeader>
          <CardTitle>Cliente y entrega</CardTitle>
          <CardDescription>A quién, dónde y cuándo se descarga el pienso.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Cliente *" htmlFor="order-customer" error={errors.customer_id?.message}>
            <CustomerPicker
              id="order-customer"
              value={customerId}
              onChange={changeCustomer}
              initialLabel={order ? `${order.customer_code} · ${order.customer_name}` : undefined}
              invalid={!!errors.customer_id}
            />
          </Field>
          <Field
            label="Explotación *"
            htmlFor="order-farm"
            error={errors.farm_id?.message}
            hint={customerId && farms.data && farmOptions.length === 0 ? "Este cliente no tiene explotaciones activas." : undefined}
          >
            <Select
              id="order-farm"
              value={farmId}
              disabled={!customerId}
              aria-invalid={errors.farm_id ? true : undefined}
              onChange={(event) => changeFarm(event.target.value)}
            >
              <option value="">
                {!customerId ? "Elige antes el cliente" : farms.isPending ? "Cargando explotaciones…" : "Elige la explotación…"}
              </option>
              {farmId && !selectedFarm && order?.farm_id === farmId ? <option value={farmId}>{order.farm_name}</option> : null}
              {farmOptions.map((farm) => (
                <option key={farm.id} value={farm.id}>
                  {farm.name}
                  {farm.city ? ` · ${farm.city}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fecha de entrega *" htmlFor="order-date" error={errors.requested_date?.message}>
            <Input
              id="order-date"
              type="date"
              min={today}
              aria-invalid={errors.requested_date ? true : undefined}
              {...register("requested_date")}
            />
          </Field>
          {!ownScope ? (
            <Field label="Comercial" htmlFor="order-rep" error={errors.sales_rep_id?.message} hint="Si no eliges, el del cliente.">
              <Select id="order-rep" {...register("sales_rep_id")}>
                <option value="">{lookups.isPending ? "Cargando…" : "El comercial del cliente"}</option>
                {order?.sales_rep_id && !salesReps.some((rep) => rep.id === order.sales_rep_id) ? (
                  <option value={order.sales_rep_id}>{order.sales_rep_name ?? "Comercial actual"}</option>
                ) : null}
                {salesReps.map((rep) => (
                  <option key={rep.id} value={rep.id}>
                    {optionLabel(rep)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <div className="md:col-span-2">
            <Field label="Notas" htmlFor="order-notes" error={errors.notes?.message}>
              <Textarea id="order-notes" className="min-h-20" placeholder="Indicaciones para oficina o para el transporte" {...register("notes")} />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Líneas</CardTitle>
            <CardDescription>Precios en €/kg sin IVA. Puedes cambiar el precio prefijado.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <ol className="space-y-3">
            {fields.map((field, index) => {
              const line = lines?.[index];
              const lineErrors = errors.lines?.[index];
              const kg = parseDecimal(line?.quantity_kg ?? "");
              const price = parseDecimal(line?.unit_price ?? "");
              const reference = line?.reference_price ?? null;
              const manual = line ? isManualPrice(line) : false;
              const below = manual && price !== null && reference !== null && price < reference && !samePrice(price, reference);
              const source = line?.price_source ?? null;
              const amount = lineAmount(kg, price);
              const isQuoting = line ? !!quoting[line.uid] : false;
              const currentItem = order?.lines.find((orderLine) => orderLine.item_id === line?.item_id);
              const silo = line?.farm_silo ?? "";
              const n = index + 1;
              return (
                <li key={field.id} className="rounded-lg border bg-card p-3 md:p-4" data-testid={`order-line-${index}`}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">Línea {n}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Quitar la línea ${n}`}
                      disabled={fields.length === 1}
                      onClick={() => remove(index)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-12">
                    <div className="sm:col-span-2 lg:col-span-4">
                      <label htmlFor={`line-${index}-item`} className="mb-1.5 block text-sm font-medium">
                        Pienso *
                      </label>
                      <Controller
                        control={control}
                        name={`lines.${index}.item_id`}
                        render={({ field: itemField }) => (
                          <Select
                            id={`line-${index}-item`}
                            ref={itemField.ref}
                            aria-label={`Pienso de la línea ${n}`}
                            value={itemField.value}
                            aria-invalid={lineErrors?.item_id ? true : undefined}
                            onChange={(event) => changeItem(index, event.target.value)}
                          >
                            <option value="">{lookups.isPending ? "Cargando…" : "Elige el pienso…"}</option>
                            {itemField.value && currentItem && !products.some((option) => option.id === itemField.value) ? (
                              <option value={itemField.value}>
                                {currentItem.item_code} · {currentItem.item_name}
                              </option>
                            ) : null}
                            {products.map((option) => (
                              <option key={option.id} value={option.id}>
                                {optionLabel(option)}
                              </option>
                            ))}
                          </Select>
                        )}
                      />
                      <FieldError message={lineErrors?.item_id?.message} />
                    </div>
                    <div className="lg:col-span-2">
                      <label htmlFor={`line-${index}-kg`} className="mb-1.5 block text-sm font-medium">
                        Kilos *
                      </label>
                      <KgInput
                        id={`line-${index}-kg`}
                        aria-label={`Kilos de la línea ${n}`}
                        aria-invalid={lineErrors?.quantity_kg ? true : undefined}
                        {...register(`lines.${index}.quantity_kg`)}
                      />
                      <FieldError message={lineErrors?.quantity_kg?.message} />
                    </div>
                    <div className="lg:col-span-3">
                      <label htmlFor={`line-${index}-price`} className="mb-1.5 block text-sm font-medium">
                        Precio
                      </label>
                      <KgInput
                        id={`line-${index}-price`}
                        suffix="€/kg"
                        className="pr-14"
                        aria-label={`Precio de la línea ${n}`}
                        aria-invalid={lineErrors?.unit_price ? true : undefined}
                        placeholder={isQuoting ? "Consultando…" : undefined}
                        {...register(`lines.${index}.unit_price`)}
                      />
                      <div className="mt-1 flex min-h-5 flex-wrap items-center gap-1.5 text-xs text-muted-foreground" data-testid={`line-${index}-price-source`}>
                        {isQuoting ? (
                          <span>Consultando precio…</span>
                        ) : manual ? (
                          <>
                            <PriceSourceBadge source="manual" />
                            {reference !== null ? <span>Ref. {formatPrice(reference)}</span> : null}
                          </>
                        ) : source && source !== "none" && source !== "manual" ? (
                          <PriceSourceBadge source={source} />
                        ) : source === "none" ? (
                          <span>Sin precio para este cliente: indícalo.</span>
                        ) : null}
                      </div>
                      {below && reference !== null && price !== null ? (
                        <p className="mt-1 flex items-start gap-1 text-xs font-medium text-warning" role="status">
                          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                          Por debajo del precio de referencia ({formatPercent(priceDifferencePct(price, reference))}).
                        </p>
                      ) : null}
                      <FieldError message={lineErrors?.unit_price?.message} />
                    </div>
                    <div className="lg:col-span-3">
                      <label htmlFor={`line-${index}-silo`} className="mb-1.5 block text-sm font-medium">
                        Silo de destino
                      </label>
                      <Select
                        id={`line-${index}-silo`}
                        aria-label={`Silo de destino de la línea ${n}`}
                        disabled={!farmId}
                        aria-invalid={lineErrors?.farm_silo ? true : undefined}
                        {...register(`lines.${index}.farm_silo`)}
                      >
                        <option value="">{siloNames.length ? "Sin indicar" : "La explotación no tiene silos"}</option>
                        {silo && !siloNames.includes(silo) ? <option value={silo}>{silo}</option> : null}
                        {siloNames.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </Select>
                      <FieldError message={lineErrors?.farm_silo?.message} />
                    </div>
                    <div className="sm:col-span-2 lg:col-span-9">
                      <Input
                        aria-label={`Notas de la línea ${n}`}
                        placeholder="Notas de la línea (opcional)"
                        {...register(`lines.${index}.notes`)}
                      />
                      <FieldError message={lineErrors?.notes?.message} />
                    </div>
                    <p className="flex items-center justify-between gap-2 text-sm sm:col-span-2 lg:col-span-3 lg:justify-end">
                      <span className="text-muted-foreground">Importe</span>
                      <span className="font-semibold tabular-nums" data-testid={`line-${index}-amount`}>
                        {formatMoney(amount)}
                      </span>
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
          <FieldError message={linesError} />
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={fields.length >= MAX_LINES}
            onClick={() => append(emptyLine())}
          >
            <Plus aria-hidden /> Añadir línea
          </Button>
        </CardContent>
      </Card>

      <div className="sticky bottom-2 z-10 rounded-lg border bg-card/95 p-3 shadow-md backdrop-blur md:p-4">
        <dl className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm">
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Total</dt>
            <dd className="font-semibold tabular-nums" data-testid="order-total-kg">
              {formatKg(totalKg)}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Importe sin IVA</dt>
            <dd className="text-base font-bold tabular-nums" data-testid="order-total-amount">
              {formatMoney(totalAmount)}
            </dd>
          </div>
          {missingPrice ? <p className="w-full text-xs text-muted-foreground">Hay líneas sin precio: se aplicará el del cliente, si lo tiene.</p> : null}
        </dl>
        {formError ? (
          <p className="mb-3 text-sm text-destructive" role="alert">
            {formError}
          </p>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" asChild>
            <Link href={order ? `/pedidos/${order.id}` : "/pedidos"}>Cancelar</Link>
          </Button>
          <Button
            variant={canSubmit ? "outline" : "default"}
            loading={save.isPending && save.variables?.submit === false}
            disabled={save.isPending}
            onClick={() => send(false)}
          >
            {saveLabel}
          </Button>
          {canSubmit ? (
            <Button loading={save.isPending && save.variables?.submit === true} disabled={save.isPending} onClick={() => send(true)}>
              <Send aria-hidden /> Enviar a validar
            </Button>
          ) : null}
        </div>
      </div>
    </form>
  );
}
