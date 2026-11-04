"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/common/states";
import { reasonError } from "@/components/orders/order-dialogs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { api } from "@/lib/api";
import { friendlyMessage, isApiError } from "@/lib/errors";
import type { DeliverPayload, LoadDetail, LoadStop } from "@/types/fase3";

import { invalidateLogistics } from "./common";

const RECEIVED_BY_MAX = 200;
const DELIVERY_NOTES_MAX = 1000;

interface LoadRef {
  id: string;
  number: string;
}

/** Valor para un `<input type="datetime-local">` con la hora local actual. */
export function localDateTimeValue(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Cancelar una carga planificada o lista: con motivo; sus pedidos vuelven a confirmados. */
export function CancelLoadDialog({ load, onClose }: { load: LoadRef; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (text: string) => api.post<LoadDetail>(`/loads/${load.id}/cancel`, { reason: text }),
    onSuccess: () => {
      toast.success(`Carga ${load.number} cancelada. Sus pedidos vuelven a estar pendientes de planificar.`);
      invalidateLogistics(queryClient);
      onClose();
    },
    onError: (failure) => {
      if (isApiError(failure) && failure.field === "reason") setError(friendlyMessage(failure));
      toast.error(friendlyMessage(failure));
    },
  });

  const confirm = () => {
    const problem = reasonError(reason);
    setError(problem);
    if (!problem) mutation.mutate(reason.trim());
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancelar la carga {load.number}</DialogTitle>
          <DialogDescription>Los pedidos de la carga vuelven a «Confirmado» para planificarlos en otra. El motivo queda en la ficha.</DialogDescription>
        </DialogHeader>
        <Field label="Motivo *" htmlFor="load-cancel-reason" error={error ?? undefined} hint="Máximo 500 caracteres.">
          <Textarea
            id="load-cancel-reason"
            value={reason}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setReason(event.target.value);
              if (error) setError(reasonError(event.target.value));
            }}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Volver
          </Button>
          <Button variant="destructive" loading={mutation.isPending} onClick={confirm}>
            Cancelar carga
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Construye el cuerpo de «Confirmar entrega»: solo lo que se ha rellenado. */
export function buildDeliverPayload(values: { receivedBy: string; deliveredAt: string; notes: string }): DeliverPayload {
  const payload: DeliverPayload = {};
  if (values.receivedBy.trim()) payload.received_by = values.receivedBy.trim();
  if (values.deliveredAt) {
    const date = new Date(values.deliveredAt);
    if (!Number.isNaN(date.getTime())) payload.delivered_at = date.toISOString();
  }
  if (values.notes.trim()) payload.notes = values.notes.trim();
  return payload;
}

/** Confirmar la entrega de una parada: quién lo recibe, cuándo y notas. */
export function DeliverDialog({ load, stop, onClose }: { load: LoadRef; stop: LoadStop; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [receivedBy, setReceivedBy] = useState("");
  const [deliveredAt, setDeliveredAt] = useState(() => localDateTimeValue());
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{ receivedBy?: string; deliveredAt?: string; notes?: string }>({});

  const mutation = useMutation({
    mutationFn: (payload: DeliverPayload) => api.post<LoadDetail>(`/loads/${load.id}/stops/${stop.id}/deliver`, payload),
    onSuccess: () => {
      toast.success(`Entrega de ${stop.customer_name} confirmada.`);
      invalidateLogistics(queryClient);
      onClose();
    },
    onError: (failure) => {
      const message = friendlyMessage(failure);
      if (isApiError(failure)) {
        if (failure.field === "received_by") setErrors({ receivedBy: message });
        if (failure.field === "delivered_at") setErrors({ deliveredAt: message });
        if (failure.field === "notes") setErrors({ notes: message });
      }
      toast.error(message);
    },
  });

  const confirm = () => {
    const next: typeof errors = {};
    if (receivedBy.trim().length > RECEIVED_BY_MAX) next.receivedBy = `Como máximo ${RECEIVED_BY_MAX} caracteres.`;
    if (notes.trim().length > DELIVERY_NOTES_MAX) next.notes = `Como máximo ${DELIVERY_NOTES_MAX} caracteres.`;
    if (deliveredAt && new Date(deliveredAt).getTime() > Date.now() + 5 * 60_000) next.deliveredAt = "La entrega no puede ser en el futuro.";
    setErrors(next);
    if (Object.keys(next).length === 0) mutation.mutate(buildDeliverPayload({ receivedBy, deliveredAt, notes }));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirmar entrega</DialogTitle>
          <DialogDescription>
            Parada {stop.sequence}: {stop.customer_name} — {stop.farm_name}. El pedido {stop.order_number} pasará a «Entregado».
          </DialogDescription>
        </DialogHeader>
        <Field label="Recibido por" htmlFor="deliver-received-by" error={errors.receivedBy} hint="Nombre de quien recibe el pienso (opcional).">
          <Input
            id="deliver-received-by"
            value={receivedBy}
            autoComplete="off"
            maxLength={RECEIVED_BY_MAX + 20}
            aria-invalid={errors.receivedBy ? true : undefined}
            onChange={(event) => setReceivedBy(event.target.value)}
          />
        </Field>
        <Field label="Fecha y hora de entrega" htmlFor="deliver-at" error={errors.deliveredAt}>
          <Input
            id="deliver-at"
            type="datetime-local"
            value={deliveredAt}
            max={localDateTimeValue()}
            aria-invalid={errors.deliveredAt ? true : undefined}
            onChange={(event) => setDeliveredAt(event.target.value)}
          />
        </Field>
        <Field label="Notas" htmlFor="deliver-notes" error={errors.notes}>
          <Textarea
            id="deliver-notes"
            className="min-h-20"
            value={notes}
            aria-invalid={errors.notes ? true : undefined}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Volver
          </Button>
          <Button loading={mutation.isPending} onClick={confirm}>
            Confirmar entrega
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
