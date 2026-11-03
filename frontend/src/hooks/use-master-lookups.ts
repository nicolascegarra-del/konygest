"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { LookupOption, MasterLookups } from "@/types/fase1";

export const LOOKUPS_KEY = ["masters", "lookups"] as const;

/**
 * Opciones activas para los desplegables (IVA, formas de pago, tarifas, transportistas,
 * comerciales, silos y artículos). Cambian poco: se guardan un minuto en caché y se invalidan
 * con cualquier alta o edición de maestros (todas comparten el prefijo `["masters"]`).
 */
export function useMasterLookups(enabled = true) {
  return useQuery({
    queryKey: LOOKUPS_KEY,
    queryFn: ({ signal }) => api.get<MasterLookups>("/masters/lookups", undefined, signal),
    staleTime: 60_000,
    enabled,
  });
}

/** Texto de una opción: «COD · Nombre» si tiene código. */
export function optionLabel(option: LookupOption): string {
  return option.code ? `${option.code} · ${option.name}` : option.name;
}
