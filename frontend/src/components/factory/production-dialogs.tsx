"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { numberInput } from "@/components/masters/form-schema";
import { Field } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { api } from "@/lib/api";
import { friendlyMessage, isApiError } from "@/lib/errors";
import { formatKg, numberToInput, toIsoDate } from "@/lib/format";
import type { FinishOrderPayload, ProductionOrder, ProductionOrderPayload } from "@/types/fase1";

import { invalidateStock, KgInput, LookupSelect } from "./common";

/** Tras cambiar una orden: órdenes, widget de hoy y (si se termina) el stock. */
export function invalidateProduction(queryClient: ReturnType<typeof useQueryClient>, stock = false) {
  void queryClient.invalidateQueries({ queryKey: ["production"] });
  if (stock) invalidateStock(queryClient);
}

const orderSchema = z.object({
  item_id: z.string().min(1, "Elige el pienso."),
  silo_id: z.string().min(1, "Elige el silo de destino."),
  planned_kg: numberInput({ required: true, positive: true }),
  planned_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Indica la fecha prevista."),
  notes: z.string().trim().max(1000, "Como máximo 1000 caracteres."),
});
type OrderInput = z.input<typeof orderSchema>;
type OrderOutput = z.output<typeof orderSchema>;

/** Alta o edición (solo en estado «prevista») de una orden de fabricación. */
export function OrderDialog({ order, onClose }: { order: ProductionOrder | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<OrderInput, unknown, OrderOutput>({
    resolver: zodResolver(orderSchema),
    defaultValues: {
      item_id: order?.item_id ?? "",
      silo_id: order?.silo_id ?? "",
      planned_kg: numberToInput(order?.planned_kg),
      planned_date: order?.planned_date.slice(0, 10) ?? toIsoDate(),
      notes: order?.notes ?? "",
    },
  });

  const save = useMutation({
    mutationFn: (values: OrderOutput) => {
      const payload: ProductionOrderPayload = { ...values, planned_kg: values.planned_kg ?? 0 };
      return order
        ? api.put<ProductionOrder>(`/production/orders/${order.id}`, payload)
        : api.post<ProductionOrder>("/production/orders", payload);
    },
    onSuccess: (saved) => {
      toast.success(order ? `Orden ${saved.number} actualizada.` : `Orden ${saved.number} creada.`);
      invalidateProduction(queryClient);
      onClose();
    },
    onError: (error) => {
      if (isApiError(error) && (error.field === "item_id" || error.field === "silo_id")) {
        setError(error.field, { type: "server", message: friendlyMessage(error) });
      }
      toast.error(friendlyMessage(error));
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{order ? `Editar orden ${order.number}` : "Nueva orden de fabricación"}</DialogTitle>
          <DialogDescription>Qué pienso fabricar, cuánto, cuándo y en qué silo se descarga.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((values) => save.mutate(values))} className="space-y-4" noValidate>
          <Field label="Pienso *" htmlFor="order-item" error={errors.item_id?.message}>
            <Controller
              control={control}
              name="item_id"
              render={({ field }) => (
                <LookupSelect
                  id="order-item"
                  lookup="items"
                  kind="product"
                  value={field.value}
                  onChange={field.onChange}
                  emptyLabel="Elige el pienso…"
                  invalid={!!errors.item_id}
                />
              )}
            />
          </Field>
          <Field label="Silo de destino *" htmlFor="order-silo" error={errors.silo_id?.message}>
            <Controller
              control={control}
              name="silo_id"
              render={({ field }) => (
                <LookupSelect
                  id="order-silo"
                  lookup="silos"
                  value={field.value}
                  onChange={field.onChange}
                  emptyLabel="Elige el silo…"
                  invalid={!!errors.silo_id}
                />
              )}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cantidad prevista *" htmlFor="order-kg" error={errors.planned_kg?.message}>
              <KgInput id="order-kg" aria-invalid={errors.planned_kg ? true : undefined} {...register("planned_kg")} />
            </Field>
            <Field label="Fecha prevista *" htmlFor="order-date" error={errors.planned_date?.message}>
              <Input id="order-date" type="date" {...register("planned_date")} />
            </Field>
          </div>
          <Field label="Notas" htmlFor="order-notes" error={errors.notes?.message}>
            <Textarea id="order-notes" {...register("notes")} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              {order ? "Guardar" : "Crear orden"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const finishSchema = z.object({
  produced_kg: numberInput({ required: true, positive: true }),
  silo_id: z.string().min(1, "Elige el silo donde se descarga."),
});
type FinishInput = z.input<typeof finishSchema>;
type FinishOutput = z.output<typeof finishSchema>;

/** Terminar una orden: kilos producidos (prefijados con lo previsto) y silo donde entran. */
export function FinishDialog({ order, onClose }: { order: ProductionOrder; onClose: () => void }) {
  const queryClient = useQueryClient();
  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FinishInput, unknown, FinishOutput>({
    resolver: zodResolver(finishSchema),
    defaultValues: { produced_kg: numberToInput(order.planned_kg), silo_id: order.silo_id },
  });

  const finish = useMutation({
    mutationFn: (values: FinishOutput) => {
      const payload: FinishOrderPayload = { produced_kg: values.produced_kg ?? 0, silo_id: values.silo_id };
      return api.post<ProductionOrder>(`/production/orders/${order.id}/finish`, payload);
    },
    onSuccess: (saved) => {
      toast.success(`Orden ${saved.number} terminada: ${formatKg(saved.produced_kg)} al silo ${saved.silo_name}.`);
      invalidateProduction(queryClient, true);
      onClose();
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Terminar orden {order.number}</DialogTitle>
          <DialogDescription>
            {order.item_name}: previstos {formatKg(order.planned_kg)}. Lo producido entra en el stock del silo.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((values) => finish.mutate(values))} className="space-y-4" noValidate>
          <Field label="Kilos producidos *" htmlFor="finish-kg" error={errors.produced_kg?.message}>
            <KgInput id="finish-kg" aria-invalid={errors.produced_kg ? true : undefined} {...register("produced_kg")} />
          </Field>
          <Field label="Silo de destino *" htmlFor="finish-silo" error={errors.silo_id?.message}>
            <Controller
              control={control}
              name="silo_id"
              render={({ field }) => (
                <LookupSelect
                  id="finish-silo"
                  lookup="silos"
                  value={field.value}
                  onChange={field.onChange}
                  emptyLabel="Elige el silo…"
                  invalid={!!errors.silo_id}
                />
              )}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={finish.isPending}>
              Terminar orden
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
