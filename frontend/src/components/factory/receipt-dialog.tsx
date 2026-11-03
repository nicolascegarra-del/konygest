"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { numberInput } from "@/components/masters/form-schema";
import { Field } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { api } from "@/lib/api";
import { friendlyMessage, isApiError } from "@/lib/errors";
import { formatKg, parseDecimal } from "@/lib/format";
import type { RawMaterialReceipt, ReceiptPayload } from "@/types/fase1";

import { invalidateStock, KgInput, LookupSelect } from "./common";

const TARE_ERROR = "La tara debe ser menor que el peso bruto.";

const receiptSchema = z
  .object({
    item_id: z.string().min(1, "Elige la materia prima."),
    silo_id: z.string().min(1, "Elige el silo o almacén."),
    supplier: z.string().trim().max(200, "Como máximo 200 caracteres."),
    delivery_note: z.string().trim().max(50, "Como máximo 50 caracteres."),
    plate: z.string().trim().max(15, "Como máximo 15 caracteres.").transform((text) => text.toUpperCase()),
    gross_kg: numberInput({ required: true, positive: true }),
    tare_kg: numberInput({ required: true, min: 0 }),
    received_at: z.string(),
    notes: z.string().trim().max(1000, "Como máximo 1000 caracteres."),
  })
  .superRefine((values, ctx) => {
    if (values.gross_kg !== null && values.tare_kg !== null && values.tare_kg >= values.gross_kg) {
      ctx.addIssue({ code: "custom", path: ["tare_kg"], message: TARE_ERROR });
    }
  });

type ReceiptInput = z.input<typeof receiptSchema>;
type ReceiptOutput = z.output<typeof receiptSchema>;

/** Neto en vivo (bruto − tara) o `null` si aún no se puede calcular. */
export function computeNet(gross: string, tare: string): number | null {
  const grossKg = parseDecimal(gross);
  const tareKg = parseDecimal(tare);
  if (grossKg === null || tareKg === null) return null;
  return Math.round((grossKg - tareKg) * 100) / 100;
}

/**
 * Entrada de materia prima (báscula): bruto y tara, el neto se calcula en vivo y es lo que entra en el silo.
 * La fecha de recepción es opcional (si se deja vacía, el servidor usa la hora actual).
 */
export function ReceiptDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ReceiptInput, unknown, ReceiptOutput>({
    resolver: zodResolver(receiptSchema),
    defaultValues: {
      item_id: "",
      silo_id: "",
      supplier: "",
      delivery_note: "",
      plate: "",
      gross_kg: "",
      tare_kg: "",
      received_at: "",
      notes: "",
    },
  });
  const [gross, tare] = useWatch({ control, name: ["gross_kg", "tare_kg"] });
  const net = computeNet(gross, tare);

  const save = useMutation({
    mutationFn: (values: ReceiptOutput) => {
      const payload: ReceiptPayload = {
        item_id: values.item_id,
        silo_id: values.silo_id,
        supplier: values.supplier,
        delivery_note: values.delivery_note,
        plate: values.plate,
        gross_kg: values.gross_kg ?? 0,
        tare_kg: values.tare_kg ?? 0,
        notes: values.notes,
        ...(values.received_at ? { received_at: new Date(values.received_at).toISOString() } : {}),
      };
      return api.post<RawMaterialReceipt>("/stock/receipts", payload);
    },
    onSuccess: (receipt) => {
      toast.success(`Entrada ${receipt.number} registrada: ${formatKg(receipt.net_kg)}.`);
      invalidateStock(queryClient);
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Entrada de materia prima</DialogTitle>
          <DialogDescription>Registra lo que marca la báscula: el neto entra en el silo elegido.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((values) => save.mutate(values))} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Materia prima *" htmlFor="receipt-item" error={errors.item_id?.message}>
              <Controller
                control={control}
                name="item_id"
                render={({ field }) => (
                  <LookupSelect
                    id="receipt-item"
                    lookup="items"
                    kind="raw_material"
                    value={field.value}
                    onChange={field.onChange}
                    emptyLabel="Elige la materia prima…"
                    invalid={!!errors.item_id}
                  />
                )}
              />
            </Field>
            <Field label="Silo o almacén *" htmlFor="receipt-silo" error={errors.silo_id?.message}>
              <Controller
                control={control}
                name="silo_id"
                render={({ field }) => (
                  <LookupSelect
                    id="receipt-silo"
                    lookup="silos"
                    value={field.value}
                    onChange={field.onChange}
                    emptyLabel="Elige el silo…"
                    invalid={!!errors.silo_id}
                  />
                )}
              />
            </Field>
            <Field label="Proveedor" htmlFor="receipt-supplier" error={errors.supplier?.message}>
              <Input id="receipt-supplier" autoComplete="off" {...register("supplier")} />
            </Field>
            <Field label="Albarán" htmlFor="receipt-note" error={errors.delivery_note?.message}>
              <Input id="receipt-note" autoComplete="off" {...register("delivery_note")} />
            </Field>
            <Field label="Matrícula" htmlFor="receipt-plate" error={errors.plate?.message}>
              <Input id="receipt-plate" autoComplete="off" className="uppercase" {...register("plate")} />
            </Field>
            <Field
              label="Fecha y hora de recepción"
              htmlFor="receipt-date"
              hint="Vacío = ahora."
              error={errors.received_at?.message}
            >
              <Input id="receipt-date" type="datetime-local" {...register("received_at")} />
            </Field>
            <Field label="Peso bruto *" htmlFor="receipt-gross" error={errors.gross_kg?.message}>
              <KgInput id="receipt-gross" aria-invalid={errors.gross_kg ? true : undefined} {...register("gross_kg")} />
            </Field>
            <Field label="Tara *" htmlFor="receipt-tare" error={errors.tare_kg?.message}>
              <KgInput id="receipt-tare" aria-invalid={errors.tare_kg ? true : undefined} {...register("tare_kg")} />
            </Field>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-muted px-4 py-3" aria-live="polite">
            <span className="text-sm text-muted-foreground">Peso neto</span>
            <output
              data-testid="receipt-net"
              className={net !== null && net <= 0 ? "text-lg font-bold text-destructive" : "text-lg font-bold"}
            >
              {net === null ? "—" : formatKg(net)}
            </output>
          </div>

          <Field label="Notas" htmlFor="receipt-notes" error={errors.notes?.message}>
            <Textarea id="receipt-notes" {...register("notes")} />
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              Registrar entrada
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
