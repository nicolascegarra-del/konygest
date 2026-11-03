"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus } from "lucide-react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { numberInput } from "@/components/masters/form-schema";
import { Field } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { formatKg } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Page } from "@/types/api";
import type { AdjustmentPayload, StockLevel, StockMovement } from "@/types/fase1";

import { invalidateStock, KgInput, LookupSelect } from "./common";

const adjustmentSchema = z.object({
  item_id: z.string().min(1, "Elige el artículo."),
  silo_id: z.string().min(1, "Elige el silo o almacén."),
  direction: z.enum(["in", "out"]),
  quantity: numberInput({ required: true, positive: true }),
  reason: z.string().trim().min(1, "Indica el motivo del ajuste.").max(500, "Como máximo 500 caracteres."),
});

type AdjustmentInput = z.input<typeof adjustmentSchema>;
type AdjustmentOutput = z.output<typeof adjustmentSchema>;

/** Saldo actual de un artículo en un silo (0 si no hay movimientos). */
export function useStockBalance(itemId: string, siloId: string) {
  return useQuery({
    queryKey: ["stock", "levels", "balance", itemId, siloId],
    enabled: !!itemId && !!siloId,
    queryFn: async ({ signal }) => {
      const page = await api.get<Page<StockLevel>>("/stock/levels", { item_id: itemId, silo_id: siloId, limit: 1 }, signal);
      return page.items[0]?.quantity_kg ?? 0;
    },
  });
}

/**
 * Ajuste manual de stock: suma o resta kilos en un silo con un motivo obligatorio.
 * Se elige «Sumar» o «Restar» con botones (los teclados numéricos del móvil no siempre tienen «−»)
 * y se envía la cantidad con signo.
 */
export function AdjustmentDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<AdjustmentInput, unknown, AdjustmentOutput>({
    resolver: zodResolver(adjustmentSchema),
    defaultValues: { item_id: "", silo_id: "", direction: "in", quantity: "", reason: "" },
  });
  const [itemId, siloId] = useWatch({ control, name: ["item_id", "silo_id"] });
  const balance = useStockBalance(itemId, siloId);

  const save = useMutation({
    mutationFn: (values: AdjustmentOutput) => {
      const quantity = values.quantity ?? 0;
      const payload: AdjustmentPayload = {
        item_id: values.item_id,
        silo_id: values.silo_id,
        quantity_kg: values.direction === "out" ? -quantity : quantity,
        reason: values.reason,
      };
      return api.post<StockMovement>("/stock/adjustments", payload);
    },
    onSuccess: (movement) => {
      toast.success(`Ajuste registrado: ${formatKg(movement.quantity_kg, { signed: true })}.`);
      invalidateStock(queryClient);
      onClose();
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajuste de stock</DialogTitle>
          <DialogDescription>Corrige el saldo de un artículo en un silo. Queda registrado con su motivo.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((values) => save.mutate(values))} className="space-y-4" noValidate>
          <Field label="Artículo *" htmlFor="adjust-item" error={errors.item_id?.message}>
            <Controller
              control={control}
              name="item_id"
              render={({ field }) => (
                <LookupSelect
                  id="adjust-item"
                  lookup="items"
                  value={field.value}
                  onChange={field.onChange}
                  emptyLabel="Elige el artículo…"
                  invalid={!!errors.item_id}
                />
              )}
            />
          </Field>
          <Field label="Silo o almacén *" htmlFor="adjust-silo" error={errors.silo_id?.message}>
            <Controller
              control={control}
              name="silo_id"
              render={({ field }) => (
                <LookupSelect
                  id="adjust-silo"
                  lookup="silos"
                  value={field.value}
                  onChange={field.onChange}
                  emptyLabel="Elige el silo…"
                  invalid={!!errors.silo_id}
                />
              )}
            />
          </Field>
          {itemId && siloId ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Stock actual en el silo:{" "}
              <strong className="text-foreground">{balance.isPending ? "…" : formatKg(balance.data ?? 0)}</strong>
            </p>
          ) : null}

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Tipo de ajuste</legend>
            <Controller
              control={control}
              name="direction"
              render={({ field }) => (
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["in", "Sumar", Plus],
                      ["out", "Restar", Minus],
                    ] as const
                  ).map(([value, label, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={field.value === value}
                      onClick={() => field.onChange(value)}
                      className={cn(
                        "inline-flex min-h-11 items-center justify-center gap-2 rounded-md border text-sm font-medium",
                        field.value === value ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
                      )}
                    >
                      <Icon className="size-4" aria-hidden /> {label}
                    </button>
                  ))}
                </div>
              )}
            />
          </fieldset>

          <Field label="Cantidad *" htmlFor="adjust-quantity" error={errors.quantity?.message}>
            <KgInput id="adjust-quantity" aria-invalid={errors.quantity ? true : undefined} {...register("quantity")} />
          </Field>
          <Field label="Motivo *" htmlFor="adjust-reason" error={errors.reason?.message}>
            <Textarea
              id="adjust-reason"
              placeholder="Merma, rotura de saco, error de pesada…"
              aria-invalid={errors.reason ? true : undefined}
              {...register("reason")}
            />
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              Registrar ajuste
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
