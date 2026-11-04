"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button, type ButtonProps } from "@/components/ui/button";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { formatKg } from "@/lib/format";
import { LOAD_STATUS_LABELS, LOAD_STATUS_VARIANTS } from "@/lib/labels";
import { occupancyPct } from "@/lib/loads";
import { cn } from "@/lib/utils";
import type { Page } from "@/types/api";
import type { Driver, Truck } from "@/types/fase1";
import type { LoadStatus } from "@/types/fase3";

/** Prefijo de las consultas de cargas (listados, fichas y widgets). */
export const LOADS_KEY = ["loads"] as const;
/** Prefijo de las consultas del tablero (pedidos pendientes de planificar). */
export const LOGISTICS_KEY = ["logistics"] as const;

export function loadDetailKey(loadId: string) {
  return ["loads", "detail", loadId] as const;
}

/**
 * Tras cambiar una carga: se refrescan cargas, tablero y pedidos (cambian de estado);
 * con `stock` también los saldos (la pesada saca el pienso de los silos).
 */
export function invalidateLogistics(queryClient: QueryClient, options: { stock?: boolean } = {}) {
  void queryClient.invalidateQueries({ queryKey: LOADS_KEY });
  void queryClient.invalidateQueries({ queryKey: LOGISTICS_KEY });
  void queryClient.invalidateQueries({ queryKey: ["orders"] });
  if (options.stock) void queryClient.invalidateQueries({ queryKey: ["stock"] });
}

export function LoadStatusBadge({ status }: { status: LoadStatus }) {
  return <Badge variant={LOAD_STATUS_VARIANTS[status]}>{LOAD_STATUS_LABELS[status]}</Badge>;
}

/** Camiones activos con sus compartimentos (no están en `/masters/lookups`). */
export function useTrucks() {
  return useQuery({
    queryKey: ["masters", "trucks", "list", { active: true, limit: 200 }],
    staleTime: 60_000,
    queryFn: ({ signal }) => api.get<Page<Truck>>("/masters/trucks", { active: true, limit: 200 }, signal),
  });
}

export function useDrivers() {
  return useQuery({
    queryKey: ["masters", "drivers", "list", { active: true, limit: 200 }],
    staleTime: 60_000,
    queryFn: ({ signal }) => api.get<Page<Driver>>("/masters/drivers", { active: true, limit: 200 }, signal),
  });
}

/** Barra de ocupación del camión: kilos planificados sobre capacidad (texto además del color). */
export function OccupancyBar({ plannedKg, capacityKg, className }: { plannedKg: number; capacityKg: number; className?: string }) {
  const pct = occupancyPct(plannedKg, capacityKg);
  const over = capacityKg > 0 && plannedKg > capacityKg;
  return (
    <div className={cn("min-w-0", className)}>
      <div
        role="meter"
        aria-label="Ocupación del camión"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(pct, 100)}
        aria-valuetext={`${pct} %`}
        className="h-2.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", over ? "bg-destructive" : pct >= 90 ? "bg-warning" : "bg-primary")}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <p className="mt-1 flex justify-between gap-2 text-xs tabular-nums">
        <span>
          <span className="font-medium">{formatKg(plannedKg)}</span>
          <span className="text-muted-foreground"> / {formatKg(capacityKg)}</span>
        </span>
        <span className={cn("font-medium", over ? "text-destructive" : "text-muted-foreground")}>
          {pct} %{over ? " · excede" : ""}
        </span>
      </p>
    </div>
  );
}

/**
 * Abre un PDF de la API en una pestaña nueva. La pestaña se abre antes de la descarga (dentro del
 * clic) para que el navegador no la bloquee; si aun así la bloquea, se descarga el fichero.
 */
export async function openPdf(path: string, fallbackName: string): Promise<void> {
  const win = typeof window !== "undefined" ? window.open("", "_blank") : null;
  try {
    const { blob, filename } = await api.blob(path);
    const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: "application/pdf" }));
    if (win && !win.closed) {
      win.location.href = url;
    } else {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename ?? fallbackName;
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
    // Margen para que la pestaña cargue el PDF antes de liberar la memoria.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    win?.close();
    toast.error(friendlyMessage(error));
  }
}

/** Botón que descarga y abre un PDF autenticado. */
export function PdfButton({
  path,
  filename,
  label,
  variant = "outline",
  size,
  className,
}: {
  path: string;
  filename: string;
  label: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await openPdf(path, filename);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? null : <FileText aria-hidden />} {label}
    </Button>
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Button variant="ghost" size="sm" asChild className="mb-2 -ml-2">
      <Link href={href}>
        <ArrowLeft aria-hidden /> {label}
      </Link>
    </Button>
  );
}

/** Sitios del camión: «2 paradas». */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** `YYYY-MM-DD` ± días, sin pasar por zonas horarias. */
export function shiftIsoDate(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  date.setDate(date.getDate() + days);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

const longDayFormatter = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long" });

/** «martes, 3 de noviembre». */
/** «Jueves, 5 de noviembre»: solo la primera letra en mayúscula (la clase `capitalize` pondría «De»). */
export function longDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  const text = longDayFormatter.format(new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  return text.charAt(0).toUpperCase() + text.slice(1);
}
