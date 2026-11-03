"use client";

import type { QueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  LINE_PRICE_SOURCE_LABELS,
  LINE_PRICE_SOURCE_VARIANTS,
  SALES_ORDER_STATUS_LABELS,
  SALES_ORDER_STATUS_VARIANTS,
} from "@/lib/labels";
import { useAuthStore } from "@/stores/auth-store";
import type { LinePriceSource, SalesOrderStatus } from "@/types/fase2";

/** Prefijo de todas las consultas de pedidos (listados, fichas, comprobaciones y widgets). */
export const ORDERS_KEY = ["orders"] as const;

/** Tras cualquier cambio en un pedido se refrescan listados, fichas, comprobaciones y widgets. */
export function invalidateOrders(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ORDERS_KEY });
}

/** ¿Trabaja el usuario con alcance «propios» en este permiso? (el comercial: solo lo suyo). */
export function useIsOwnScope(permission: string): boolean {
  return useAuthStore((state) => state.user?.permissions[permission] === "own");
}

export function SalesOrderStatusBadge({ status }: { status: SalesOrderStatus }) {
  return <Badge variant={SALES_ORDER_STATUS_VARIANTS[status]}>{SALES_ORDER_STATUS_LABELS[status]}</Badge>;
}

export function PriceSourceBadge({ source }: { source: LinePriceSource }) {
  return <Badge variant={LINE_PRICE_SOURCE_VARIANTS[source]}>{LINE_PRICE_SOURCE_LABELS[source]}</Badge>;
}

/** Aviso de que alguna línea va por debajo del precio de referencia (icono + texto, no solo color). */
export function ManualPriceFlag({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-warning" title="Precio por debajo del de referencia">
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      {compact ? <span className="sr-only">Precio por debajo del de referencia</span> : "Precio bajo"}
    </span>
  );
}

/** Fecha local de mañana (`YYYY-MM-DD`). */
export function tomorrow(from: Date = new Date()): Date {
  const date = new Date(from);
  date.setDate(date.getDate() + 1);
  return date;
}

/** Suma `days` días a una fecha local. */
export function addDays(from: Date, days: number): Date {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return date;
}

/** Importe de una línea como lo calcula el backend: `round(kg × €/kg, 2)`. */
export function lineAmount(quantityKg: number | null, unitPrice: number | null): number | null {
  if (quantityKg === null || unitPrice === null) return null;
  return Math.round(quantityKg * unitPrice * 100) / 100;
}

/** Diferencia porcentual del precio respecto al de referencia (negativa si está por debajo). */
export function priceDifferencePct(price: number, reference: number): number {
  if (reference === 0) return 0;
  return Math.round(((price - reference) / reference) * 10000) / 100;
}

/** Dos precios iguales a efectos de 4 decimales (los €/kg viajan con 4). */
export function samePrice(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 0.00005;
}
