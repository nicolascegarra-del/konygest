"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { numberError } from "@/components/masters/form-schema";
import { ErrorState, Field, FieldError, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { optionLabel, useMasterLookups } from "@/hooks/use-master-lookups";
import { api } from "@/lib/api";
import { friendlyMessage, isApiError } from "@/lib/errors";
import { formatKg, parseDecimal } from "@/lib/format";
import { ITEM_KIND_LABELS } from "@/lib/labels";
import type { Page } from "@/types/api";
import type { InventoryLine, InventoryPayload, ItemKind, StockLevel, StockMovement } from "@/types/fase1";

import { invalidateStock, KgInput, LookupSelect } from "./common";

interface InventoryRow {
  item_id: string;
  label: string;
  kind: ItemKind | null;
  current: number;
}

/**
 * Convierte lo contado en las líneas del inventario. Solo se envían las filas tocadas
 * (con algo escrito); devuelve también los errores de las filas mal escritas.
 */
export function buildInventoryLines(
  siloId: string,
  rows: InventoryRow[],
  counted: Record<string, string>,
): { lines: InventoryLine[]; errors: string[] } {
  const lines: InventoryLine[] = [];
  const errors: string[] = [];
  for (const row of rows) {
    const text = counted[row.item_id]?.trim();
    if (!text) continue;
    const value = parseDecimal(text);
    const error = value === null ? "valor no válido" : numberError(value, { min: 0 });
    if (error || value === null) errors.push(`${row.label}: ${(error ?? "valor no válido").toLowerCase()}`);
    else lines.push({ item_id: row.item_id, silo_id: siloId, counted_kg: value });
  }
  return { lines, errors };
}

/**
 * Inventario de un silo: lista todos los artículos activos con su saldo actual y un campo «contado».
 * Se crea un movimiento `inventory` por cada artículo contado cuya cantidad difiera del saldo.
 */
export function InventoryDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const lookups = useMasterLookups();
  const [siloId, setSiloId] = useState("");
  const [search, setSearch] = useState("");
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  const levels = useQuery({
    queryKey: ["stock", "levels", "inventory", siloId],
    enabled: !!siloId,
    queryFn: ({ signal }) => api.get<Page<StockLevel>>("/stock/levels", { silo_id: siloId, limit: 200 }, signal),
  });

  const rows = useMemo<InventoryRow[]>(() => {
    const balances = new Map((levels.data?.items ?? []).map((level) => [level.item_id, level]));
    const fromLookups: InventoryRow[] = (lookups.data?.items ?? []).map((item) => ({
      item_id: item.id,
      label: optionLabel(item),
      kind: (item.kind as ItemKind | null | undefined) ?? null,
      current: balances.get(item.id)?.quantity_kg ?? 0,
    }));
    // Artículos con saldo que ya no están activos: también se pueden regularizar.
    for (const level of balances.values()) {
      if (!fromLookups.some((row) => row.item_id === level.item_id)) {
        fromLookups.push({
          item_id: level.item_id,
          label: `${level.item_code} · ${level.item_name}`,
          kind: level.item_kind,
          current: level.quantity_kg,
        });
      }
    }
    // Primero lo que hay en el silo; luego el resto por nombre.
    return fromLookups.sort((a, b) => Number(b.current !== 0) - Number(a.current !== 0) || a.label.localeCompare(b.label, "es"));
  }, [levels.data, lookups.data]);

  const term = search.trim().toLowerCase();
  const visible = term ? rows.filter((row) => row.label.toLowerCase().includes(term)) : rows;
  const touched = Object.values(counted).filter((text) => text.trim()).length;

  const save = useMutation({
    mutationFn: (payload: InventoryPayload) => api.post<{ movements: StockMovement[] }>("/stock/inventory", payload),
    onSuccess: (result, payload) => {
      const changes = result.movements.length;
      toast.success(
        changes === 0
          ? `Inventario guardado: las ${payload.lines.length} líneas cuadraban.`
          : `Inventario guardado: ${changes} ${changes === 1 ? "artículo regularizado" : "artículos regularizados"}.`,
      );
      invalidateStock(queryClient);
      onClose();
    },
    onError: (error, payload) => {
      // El servidor señala la línea con «lines.N.item_id»: se traduce al artículo.
      const match = isApiError(error) && error.field ? /^lines\.(\d+)\./.exec(error.field) : null;
      const line = match ? payload.lines[Number(match[1])] : undefined;
      const row = line ? rows.find((candidate) => candidate.item_id === line.item_id) : undefined;
      toast.error(row ? `${row.label}: ${friendlyMessage(error)}` : friendlyMessage(error));
    },
  });

  const submit = () => {
    const { lines, errors: lineErrors } = buildInventoryLines(siloId, rows, counted);
    if (lineErrors.length > 0) {
      setErrors(lineErrors);
      return;
    }
    if (lines.length === 0) {
      setErrors(["Escribe la cantidad contada de al menos un artículo."]);
      return;
    }
    setErrors([]);
    save.mutate({ lines, notes: notes.trim() });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Inventario</DialogTitle>
          <DialogDescription>
            Elige el silo y escribe lo contado. Solo se guardan los artículos en los que escribas algo.
          </DialogDescription>
        </DialogHeader>
        <Field label="Silo o almacén *" htmlFor="inventory-silo">
          <LookupSelect
            id="inventory-silo"
            lookup="silos"
            value={siloId}
            onChange={(value) => {
              setSiloId(value);
              setCounted({});
              setErrors([]);
            }}
            emptyLabel="Elige el silo…"
          />
        </Field>

        {!siloId ? null : levels.isPending || lookups.isPending ? (
          <LoadingBlock rows={4} />
        ) : levels.isError ? (
          <ErrorState error={levels.error} onRetry={() => levels.refetch()} />
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filtrar artículos"
                aria-label="Filtrar artículos"
                className="pl-9"
              />
            </div>
            <ul className="max-h-[45dvh] divide-y overflow-y-auto rounded-lg border">
              {visible.map((row) => {
                const value = counted[row.item_id] ?? "";
                const parsed = parseDecimal(value);
                const diff = parsed === null ? null : Math.round((parsed - row.current) * 100) / 100;
                return (
                  <li key={row.item_id} className="grid gap-2 p-3 sm:grid-cols-[1fr_9rem_10rem] sm:items-center">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{row.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.kind ? `${ITEM_KIND_LABELS[row.kind]} · ` : ""}Saldo actual: {formatKg(row.current)}
                      </p>
                    </div>
                    <KgInput
                      value={value}
                      aria-label={`Contado de ${row.label}`}
                      placeholder={formatKg(row.current).replace(/ kg$/, "")}
                      onChange={(event) => setCounted((current) => ({ ...current, [row.item_id]: event.target.value }))}
                    />
                    <p className="text-xs sm:text-right" aria-live="polite">
                      {diff === null || value.trim() === "" ? (
                        <span className="text-muted-foreground">Sin contar</span>
                      ) : diff === 0 ? (
                        <span className="text-muted-foreground">Cuadra</span>
                      ) : (
                        <span className={diff > 0 ? "text-success" : "text-destructive"}>
                          Diferencia: {formatKg(diff, { signed: true })}
                        </span>
                      )}
                    </p>
                  </li>
                );
              })}
              {visible.length === 0 ? (
                <li className="p-4 text-center text-sm text-muted-foreground">Ningún artículo coincide.</li>
              ) : null}
            </ul>
            <Field label="Notas" htmlFor="inventory-notes">
              <Textarea id="inventory-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
            </Field>
          </div>
        )}

        {errors.map((message) => (
          <FieldError key={message} message={message} />
        ))}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={save.isPending} disabled={!siloId || touched === 0}>
            Guardar inventario{touched > 0 ? ` (${touched})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
