"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Select, Textarea } from "@/components/ui/input";
import { api } from "@/lib/api";
import { friendlyMessage, isApiError } from "@/lib/errors";
import { decimalPlaces, formatKg, formatMoney, formatPlainDate, parseDecimal, toIsoDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  CreditLinePayload,
  CreditNotePayload,
  CreditNoteType,
  InvoiceDetail,
  InvoiceLine,
  UpdateCreditNotePayload,
} from "@/types/fase4";

import { invalidateInvoicing, invoiceHref, REASON_MAX, reasonError, round2 } from "./common";

export const CREDIT_TYPE_HELP: Record<CreditNoteType, string> = {
  R1: "Error fundado en derecho y art. 80.1, 80.2 y 80.6 LIVA: devoluciones, descuentos o precios mal aplicados. El habitual.",
  R4: "Resto de causas que no encajan en R1.",
};

type LineMode = "kg" | "amount";

interface LineState {
  mode: LineMode;
  text: string;
}

export interface LineLimits {
  /** Importe aún sin abonar (base, en positivo). */
  maxAmount: number;
  /** Kilos aún sin abonar, limitados también por el importe pendiente. */
  maxKg: number;
  creditedKg: number;
  creditedAmount: number;
}

/**
 * Lo que queda por abonar de una línea: lo facturado menos lo ya abonado en abonos emitidos.
 * Los kilos se limitan además por el importe pendiente (si ya hubo descuentos en €).
 */
export function lineLimits(line: InvoiceLine): LineLimits {
  const creditedKg = Math.abs(line.credited_kg);
  const creditedAmount = Math.abs(line.credited_amount);
  const maxAmount = Math.max(0, round2(Math.abs(line.amount) - creditedAmount));
  let maxKg = Math.max(0, round2(Math.abs(line.quantity_kg) - creditedKg));
  if (line.unit_price > 0) maxKg = Math.min(maxKg, Math.floor((maxAmount / line.unit_price) * 100 + 1e-6) / 100);
  return { maxAmount, maxKg, creditedKg, creditedAmount };
}

/** Valor tecleado de una línea → número válido, o el error que hay que enseñar. */
export function lineValueError(text: string, mode: LineMode, limits: LineLimits): { value: number | null; error: string | null } {
  if (!text.trim()) return { value: null, error: null };
  const value = parseDecimal(text);
  if (value === null) return { value: null, error: "Número no válido." };
  if (value <= 0) return { value: null, error: "Debe ser mayor que 0." };
  if (decimalPlaces(value) > 2) return { value: null, error: "Como máximo 2 decimales." };
  const max = mode === "kg" ? limits.maxKg : limits.maxAmount;
  if (value > max + 1e-9) {
    return { value: null, error: `Máximo ${mode === "kg" ? formatKg(max) : formatMoney(max)}.` };
  }
  return { value, error: null };
}

/**
 * Diálogo de abono de una factura emitida: tipo R1/R4, motivo y abono total o por líneas
 * (kg devueltos al mismo precio o descuento en €). Con `draft` edita un borrador de abono ya
 * creado de esa factura (PUT): las líneas se vuelven a indicar.
 */
export function CreditNoteDialog({
  invoice,
  draft,
  onClose,
}: {
  /** Factura emitida que se rectifica. */
  invoice: InvoiceDetail;
  draft?: InvoiceDetail;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const editing = Boolean(draft);
  const [type, setType] = useState<CreditNoteType>(draft?.invoice_type === "R4" ? "R4" : "R1");
  const [reason, setReason] = useState(draft?.rectification_reason ?? "");
  const [reasonProblem, setReasonProblem] = useState<string | null>(null);
  const [full, setFull] = useState(!editing);
  const [lineStates, setLineStates] = useState<Record<string, LineState>>({});
  const [linesProblem, setLinesProblem] = useState<string | null>(null);
  const [exceeded, setExceeded] = useState<string | null>(null);
  const [issueDate, setIssueDate] = useState(draft?.issue_date ?? "");
  const [notes, setNotes] = useState(draft?.notes ?? "");

  const lines = [...invoice.lines].sort((a, b) => a.position - b.position);
  const limits = new Map(lines.map((line) => [line.id, lineLimits(line)]));
  const pendingTotal = round2(lines.reduce((sum, line) => sum + (limits.get(line.id)?.maxAmount ?? 0), 0));

  const stateOf = (lineId: string): LineState => lineStates[lineId] ?? { mode: "kg", text: "" };
  const update = (lineId: string, patch: Partial<LineState>) =>
    setLineStates((current) => ({ ...current, [lineId]: { ...stateOf(lineId), ...patch } }));

  const parsed = lines.map((line) => {
    const state = stateOf(line.id);
    const lineLimit = limits.get(line.id) ?? lineLimits(line);
    return { line, state, ...lineValueError(state.text, state.mode, lineLimit) };
  });
  const estimated = full
    ? pendingTotal
    : round2(
        parsed.reduce((sum, row) => {
          if (row.value === null) return sum;
          return sum + (row.state.mode === "kg" ? round2(row.value * row.line.unit_price) : row.value);
        }, 0),
      );

  const onError = (failure: unknown) => {
    if (isApiError(failure, "CREDIT_EXCEEDS_INVOICE")) {
      setExceeded(failure.message || friendlyMessage(failure));
      return;
    }
    if (isApiError(failure) && failure.field === "rectification_reason") setReasonProblem(friendlyMessage(failure));
    toast.error(friendlyMessage(failure));
  };

  const create = useMutation({
    mutationFn: (payload: CreditNotePayload) => api.post<InvoiceDetail>(`/invoices/${invoice.id}/credit-note`, payload),
    onSuccess: (created) => {
      toast.success("Borrador de abono creado. Revísalo y emítelo.");
      invalidateInvoicing(queryClient);
      onClose();
      router.push(invoiceHref(created.id));
    },
    onError,
  });

  const save = useMutation({
    mutationFn: (payload: UpdateCreditNotePayload) => api.put<InvoiceDetail>(`/invoices/${draft?.id ?? ""}`, payload),
    onSuccess: () => {
      toast.success("Borrador de abono actualizado.");
      invalidateInvoicing(queryClient);
      onClose();
    },
    onError,
  });

  const confirm = () => {
    setExceeded(null);
    const problem = reasonError(reason);
    setReasonProblem(problem);
    let creditLines: CreditLinePayload[] = [];
    if (full) {
      if (pendingTotal <= 0) {
        setLinesProblem("La factura ya está abonada del todo.");
        return;
      }
      setLinesProblem(null);
    } else {
      if (parsed.some((row) => row.error)) {
        setLinesProblem("Corrige los importes marcados.");
        return;
      }
      creditLines = parsed
        .filter((row) => row.value !== null)
        .map((row) =>
          row.state.mode === "kg"
            ? { invoice_line_id: row.line.id, quantity_kg: row.value as number }
            : { invoice_line_id: row.line.id, amount: row.value as number },
        );
      if (creditLines.length === 0) {
        setLinesProblem("Indica los kg devueltos o el descuento de al menos una línea.");
        return;
      }
      setLinesProblem(null);
    }
    if (problem) return;

    if (draft) {
      // El PUT no admite `full`: se envía lo pendiente de cada línea como descuento en €.
      if (full) {
        creditLines = lines
          .filter((line) => (limits.get(line.id)?.maxAmount ?? 0) > 0)
          .map((line) => ({ invoice_line_id: line.id, amount: limits.get(line.id)?.maxAmount ?? 0 }));
      }
      const payload: UpdateCreditNotePayload = {
        lines: creditLines,
        rectification_reason: reason.trim(),
        invoice_type: type,
        notes: notes.trim(),
      };
      if (issueDate) payload.issue_date = issueDate;
      save.mutate(payload);
      return;
    }
    create.mutate(
      full
        ? { invoice_type: type, rectification_reason: reason.trim(), full: true }
        : { invoice_type: type, rectification_reason: reason.trim(), lines: creditLines },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar el borrador de abono" : `Crear abono de la factura ${invoice.number ?? ""}`}</DialogTitle>
          <DialogDescription>
            Factura rectificativa por diferencias: sus importes van en negativo. Queda como borrador hasta que la emitas.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Tipo de rectificativa</legend>
          {(["R1", "R4"] as const).map((value) => (
            <label
              key={value}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm",
                type === value && "border-primary bg-primary/5",
              )}
            >
              <input
                type="radio"
                name="credit-type"
                value={value}
                checked={type === value}
                onChange={() => setType(value)}
                className="mt-0.5 size-5 shrink-0 accent-[var(--color-primary)]"
              />
              <span>
                <span className="font-semibold">{value}</span>{" "}
                <span className="text-muted-foreground">{CREDIT_TYPE_HELP[value]}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <Field
          label="Motivo de la rectificación *"
          htmlFor="credit-reason"
          error={reasonProblem ?? undefined}
          hint={`Sale en el abono. Máximo ${REASON_MAX} caracteres.`}
        >
          <Textarea
            id="credit-reason"
            className="min-h-20"
            value={reason}
            maxLength={REASON_MAX + 50}
            aria-invalid={reasonProblem ? true : undefined}
            onChange={(event) => {
              setReason(event.target.value);
              if (reasonProblem) setReasonProblem(reasonError(event.target.value));
            }}
          />
        </Field>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Qué se abona</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={cn("flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm", full && "border-primary bg-primary/5")}>
              <input
                type="radio"
                name="credit-scope"
                checked={full}
                onChange={() => setFull(true)}
                className="size-5 shrink-0 accent-[var(--color-primary)]"
              />
              <span>
                Abono total <span className="text-muted-foreground">({formatMoney(pendingTotal)} de base pendiente)</span>
              </span>
            </label>
            <label className={cn("flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm", !full && "border-primary bg-primary/5")}>
              <input
                type="radio"
                name="credit-scope"
                checked={!full}
                onChange={() => setFull(false)}
                className="size-5 shrink-0 accent-[var(--color-primary)]"
              />
              Por líneas
            </label>
          </div>
        </fieldset>

        {!full ? (
          <ul className="space-y-3" aria-label="Líneas de la factura">
            {parsed.map(({ line, state, error }) => {
              const lineLimit = limits.get(line.id) ?? lineLimits(line);
              const done = lineLimit.maxAmount <= 0;
              const inputId = `credit-line-${line.id}`;
              return (
                <li key={line.id} className="rounded-lg border p-3 text-sm">
                  <p className="font-medium">{line.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {[line.delivery_note_number, formatPlainDate(line.delivery_date)].filter((part) => part && part !== "—").join(" · ")}
                  </p>
                  <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <dt className="text-muted-foreground">Facturado</dt>
                      <dd className="tabular-nums">
                        {formatKg(line.quantity_kg)} · {formatMoney(line.amount)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Ya abonado</dt>
                      <dd className="tabular-nums">
                        {formatKg(lineLimit.creditedKg)} · {formatMoney(lineLimit.creditedAmount)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Máximo</dt>
                      <dd className="tabular-nums">
                        {formatKg(lineLimit.maxKg)} · {formatMoney(lineLimit.maxAmount)}
                      </dd>
                    </div>
                  </dl>
                  {done ? (
                    <p className="mt-2 text-xs font-medium text-muted-foreground">Línea abonada del todo.</p>
                  ) : (
                    <div className="mt-2 grid grid-cols-[minmax(0,10rem)_1fr] gap-2">
                      <Select
                        aria-label={`Cómo se abona ${line.description}`}
                        value={state.mode}
                        onChange={(event) => update(line.id, { mode: event.target.value as LineMode })}
                      >
                        <option value="kg">Kg devueltos</option>
                        <option value="amount">Descuento (€)</option>
                      </Select>
                      <div>
                        <label htmlFor={inputId} className="sr-only">
                          {state.mode === "kg" ? `Kg devueltos de ${line.description}` : `Descuento en € de ${line.description}`}
                        </label>
                        <Input
                          id={inputId}
                          inputMode="decimal"
                          value={state.text}
                          placeholder={state.mode === "kg" ? `Hasta ${formatKg(lineLimit.maxKg)}` : `Hasta ${formatMoney(lineLimit.maxAmount)}`}
                          aria-invalid={error ? true : undefined}
                          onChange={(event) => update(line.id, { text: event.target.value })}
                        />
                        {error ? (
                          <p className="mt-1 text-xs text-destructive" role="alert">
                            {error}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}

        {linesProblem ? (
          <p className="text-sm text-destructive" role="alert">
            {linesProblem}
          </p>
        ) : null}

        {editing ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Fecha del abono" htmlFor="credit-issue-date" hint="Se puede cambiar también al emitir.">
              <Input id="credit-issue-date" type="date" value={issueDate} max={toIsoDate()} onChange={(event) => setIssueDate(event.target.value)} />
            </Field>
            <Field label="Notas" htmlFor="credit-notes">
              <Textarea id="credit-notes" className="min-h-11" maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} />
            </Field>
          </div>
        ) : null}

        <p className="rounded-lg bg-muted p-3 text-sm">
          Base a abonar: <span className="font-semibold tabular-nums">{estimated > 0 ? `−${formatMoney(estimated)}` : formatMoney(0)}</span>{" "}
          <span className="text-muted-foreground">(más el IVA correspondiente)</span>
        </p>

        {exceeded ? (
          <div role="alert" className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <div>
              <p className="font-medium">El abono supera lo facturado menos lo ya abonado.</p>
              <p className="text-muted-foreground">{exceeded}</p>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={create.isPending || save.isPending} onClick={confirm}>
            {editing ? "Guardar borrador" : "Crear borrador de abono"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
