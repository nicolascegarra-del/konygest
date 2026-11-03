"use client";

import type { QueryClient } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { optionLabel, useMasterLookups } from "@/hooks/use-master-lookups";
import { can } from "@/lib/auth";
import { formatKg } from "@/lib/format";
import { ORDER_STATUS_LABELS, ORDER_STATUS_VARIANTS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import type { LookupKey, OrderStatus } from "@/types/fase1";

/** ¿Puede el usuario escribir con este permiso? (y la cuenta no está en solo lectura). */
export function useCanWrite(permission: string): boolean {
  const me = useAuthStore((state) => state.user);
  return can(me, permission) && !me?.read_only;
}

/** Tras cualquier movimiento cambian saldos, resúmenes, libro, entradas y widgets. */
export function invalidateStock(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ["stock"] });
}

/** Desplegable de silos o artículos activos (de `/masters/lookups`). */
export function LookupSelect({
  id,
  lookup,
  kind,
  value,
  onChange,
  emptyLabel,
  invalid,
  disabled,
  className,
  ariaLabel,
}: {
  id?: string;
  lookup: Extract<LookupKey, "items" | "silos">;
  kind?: string;
  value: string;
  onChange: (value: string) => void;
  emptyLabel: string;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const lookups = useMasterLookups();
  const options = (lookups.data?.[lookup] ?? []).filter((option) => !kind || option.kind === kind);
  return (
    <Select
      id={id}
      value={value}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      className={className}
    >
      <option value="">{lookups.isPending ? "Cargando…" : emptyLabel}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {optionLabel(option)}
        </option>
      ))}
    </Select>
  );
}

/** Campo de kilos con el sufijo «kg» dentro. */
export function KgInput({
  className,
  suffix = "kg",
  ...props
}: ComponentProps<"input"> & { suffix?: string }) {
  return (
    <div className="relative">
      <Input inputMode="decimal" autoComplete="off" className={cn("pr-10", className)} {...props} />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
        {suffix}
      </span>
    </div>
  );
}

/**
 * Cantidad con signo: «+» o «−» delante (no solo el color) y texto para lectores de pantalla.
 */
export function SignedKg({ value }: { value: number }) {
  return (
    <span
      className={cn(
        "font-medium tabular-nums",
        value > 0 && "text-success",
        value < 0 && "text-destructive",
      )}
    >
      <span className="sr-only">{value >= 0 ? "Entrada: " : "Salida: "}</span>
      {formatKg(value, { signed: true })}
    </span>
  );
}

/** Pestañas sencillas (dos o tres vistas de la misma página). */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: { value: T; label: ReactNode }[];
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="mb-4 inline-flex rounded-lg border bg-muted p-1">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
          className={cn(
            "min-h-11 rounded-md px-4 text-sm font-medium transition-colors md:min-h-9",
            tab.value === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Badge de estado de una orden de fabricación. */
export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge variant={ORDER_STATUS_VARIANTS[status]}>{ORDER_STATUS_LABELS[status]}</Badge>;
}
