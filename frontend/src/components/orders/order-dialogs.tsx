"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { api } from "@/lib/api";
import { friendlyMessage, isApiError } from "@/lib/errors";
import type { ReasonPayload, SalesOrderDetail, ValidatePayload } from "@/types/fase2";

import { invalidateOrders } from "./common";

const REASON_MAX = 500;

interface OrderRef {
  id: string;
  number: string;
}

/** Valida el motivo de un rechazo o una cancelación (obligatorio, 1–500). */
export function reasonError(reason: string): string | null {
  const text = reason.trim();
  if (!text) return "Indica el motivo.";
  if (text.length > REASON_MAX) return `Como máximo ${REASON_MAX} caracteres.`;
  return null;
}

/** Rechazar (vuelve al comercial) o cancelar un pedido: siempre con motivo. */
export function ReasonDialog({
  order,
  action,
  onClose,
  onDone,
}: {
  order: OrderRef;
  action: "reject" | "cancel";
  onClose: () => void;
  onDone?: (saved: SalesOrderDetail) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isReject = action === "reject";

  const mutation = useMutation({
    mutationFn: (payload: ReasonPayload) => api.post<SalesOrderDetail>(`/orders/${order.id}/${action}`, payload),
    onSuccess: (saved) => {
      toast.success(isReject ? `Pedido ${order.number} rechazado. Se ha avisado al comercial.` : `Pedido ${order.number} cancelado.`);
      invalidateOrders(queryClient);
      onDone?.(saved);
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
    if (!problem) mutation.mutate({ reason: reason.trim() });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isReject ? `Rechazar el pedido ${order.number}` : `Cancelar el pedido ${order.number}`}</DialogTitle>
          <DialogDescription>
            {isReject
              ? "Vuelve al comercial con el motivo para que lo corrija y lo envíe de nuevo."
              : "El pedido quedará cancelado y no se podrá servir. El motivo queda en la ficha."}
          </DialogDescription>
        </DialogHeader>
        <Field label="Motivo *" htmlFor="order-reason" error={error ?? undefined} hint={`Máximo ${REASON_MAX} caracteres.`}>
          <Textarea
            id="order-reason"
            value={reason}
            maxLength={REASON_MAX + 50}
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
            {isReject ? "Rechazar pedido" : "Cancelar pedido"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Validar un pedido pendiente. Si supera el riesgo del cliente, el backend responde 409
 * `CREDIT_LIMIT_EXCEEDED`: se explica y se ofrece «Validar igualmente» (reenvía con `force`).
 */
export function ValidateDialog({
  order,
  onClose,
  onDone,
}: {
  order: OrderRef;
  onClose: () => void;
  onDone?: (saved: SalesOrderDetail) => void;
}) {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState("");
  const [creditMessage, setCreditMessage] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (payload: ValidatePayload) => api.post<SalesOrderDetail>(`/orders/${order.id}/validate`, payload),
    onSuccess: (saved, payload) => {
      toast.success(payload.force ? `Pedido ${order.number} validado superando el riesgo.` : `Pedido ${order.number} validado.`);
      invalidateOrders(queryClient);
      onDone?.(saved);
      onClose();
    },
    onError: (failure) => {
      if (isApiError(failure, "CREDIT_LIMIT_EXCEEDED")) {
        setCreditMessage(failure.message || friendlyMessage(failure));
        return;
      }
      toast.error(friendlyMessage(failure));
    },
  });

  const validate = (force: boolean) => {
    const payload: ValidatePayload = {};
    if (notes.trim()) payload.notes = notes.trim();
    if (force) payload.force = true;
    mutation.mutate(payload);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Validar el pedido {order.number}</DialogTitle>
          <DialogDescription>Queda confirmado y listo para planificar la carga. Se avisa al comercial.</DialogDescription>
        </DialogHeader>
        <Field label="Notas de la validación" htmlFor="validate-notes" hint="Opcional.">
          <Textarea id="validate-notes" className="min-h-20" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        {creditMessage ? (
          <div role="alert" className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <div>
              <p className="font-medium">El pedido supera el riesgo del cliente.</p>
              <p className="text-muted-foreground">{creditMessage}</p>
              <p className="mt-1 text-muted-foreground">Puedes validarlo igualmente: quedará registrado como forzado.</p>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Volver
          </Button>
          {creditMessage ? (
            <Button variant="destructive" loading={mutation.isPending} onClick={() => validate(true)}>
              Validar igualmente
            </Button>
          ) : (
            <Button loading={mutation.isPending} onClick={() => validate(false)}>
              Validar pedido
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
