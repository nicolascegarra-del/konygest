/**
 * Lógica pura de la planificación de cargas: reparto en compartimentos, validación del reparto a
 * mano y comprobaciones de la pesada. Sin React, para poder probarla aislada.
 */

import type { LoadItemPayload } from "@/types/fase3";

/** Línea de pedido que hay que meter en el camión (en el orden de descarga). */
export interface AllocLine {
  id: string;
  quantity_kg: number;
}

/** Parada de la carga con sus líneas, ya en el orden de descarga. */
export interface AllocStop {
  order_id: string;
  lines: AllocLine[];
}

export interface Allocation {
  items: LoadItemPayload[];
  /** Kilos que no caben (0 si cabe todo). */
  missingKg: number;
  fits: boolean;
}

/** Kilos a céntimos de kilo: el reparto se hace en enteros para no arrastrar errores de coma flotante. */
const toCents = (kg: number) => Math.round(kg * 100);
const fromCents = (cents: number) => cents / 100;

/**
 * Reparto automático, el mismo que hace el servidor cuando no se envía `items`:
 * recorre las paradas en orden y rellena los compartimentos en orden; una línea que no cabe
 * en un compartimento sigue en el siguiente, y un compartimento solo lleva una línea (aunque
 * le sobre sitio, la siguiente línea empieza en el compartimento siguiente).
 * @param compartments - Capacidad en kg de cada compartimento (índice 0 = compartimento 1).
 * @param stops - Paradas en el orden de descarga, con sus líneas.
 * @returns Los `items` a enviar, los kilos que faltan y si cabe todo.
 */
export function autoAllocate(compartments: number[], stops: AllocStop[]): Allocation {
  const items: LoadItemPayload[] = [];
  let next = 0;
  let missing = 0;
  for (const stop of stops) {
    for (const line of stop.lines) {
      let remaining = toCents(line.quantity_kg);
      while (remaining > 0) {
        if (next >= compartments.length) {
          missing += remaining;
          break;
        }
        const capacity = toCents(compartments[next] ?? 0);
        if (capacity <= 0) {
          next += 1;
          continue;
        }
        const take = Math.min(remaining, capacity);
        items.push({ order_line_id: line.id, compartment: next + 1, planned_kg: fromCents(take) });
        remaining -= take;
        next += 1;
      }
    }
  }
  return { items, missingKg: fromCents(missing), fits: missing === 0 };
}

/** Asignación de un compartimento en el reparto a mano (lo que hay en el formulario). */
export interface ManualAssignment {
  lineId: string;
  /** Kilos tal y como se han tecleado (ya convertidos a número; `null` si vacío o inválido). */
  kg: number | null;
}

export interface ManualValidation {
  /** Error por compartimento (índice 0 = compartimento 1). */
  compartmentErrors: Record<number, string>;
  /** Error por línea: no suma su cantidad. */
  lineErrors: Record<string, string>;
  /** Kilos asignados a cada línea. */
  assignedByLine: Record<string, number>;
  /** `items` listos para enviar si no hay errores; si no, `null`. */
  items: LoadItemPayload[] | null;
}

/**
 * Valida el reparto a mano con las reglas del contrato: una línea por compartimento, sin
 * superar su capacidad, y cada línea debe sumar exactamente su cantidad.
 * @param compartments - Capacidades del camión.
 * @param lines - Líneas de los pedidos de la carga.
 * @param assignments - Lo asignado a cada compartimento (índice = compartimento − 1).
 * @param formatKg - Formateador para los mensajes.
 */
export function validateManualAllocation(
  compartments: number[],
  lines: AllocLine[],
  assignments: (ManualAssignment | undefined)[],
  formatKg: (kg: number) => string,
): ManualValidation {
  const compartmentErrors: Record<number, string> = {};
  const lineErrors: Record<string, string> = {};
  const assignedCents: Record<string, number> = {};
  const items: LoadItemPayload[] = [];
  const known = new Set(lines.map((line) => line.id));

  compartments.forEach((capacity, index) => {
    const assignment = assignments[index];
    if (!assignment || !assignment.lineId) {
      if (assignment && assignment.kg !== null && assignment.kg > 0) compartmentErrors[index] = "Elige qué línea va en este compartimento.";
      return;
    }
    if (!known.has(assignment.lineId)) {
      compartmentErrors[index] = "Esa línea ya no está en la carga.";
      return;
    }
    if (assignment.kg === null || assignment.kg <= 0) {
      compartmentErrors[index] = "Indica los kilos (mayor que 0).";
      return;
    }
    if (toCents(assignment.kg) > toCents(capacity)) {
      compartmentErrors[index] = `Supera la capacidad del compartimento (${formatKg(capacity)}).`;
      return;
    }
    assignedCents[assignment.lineId] = (assignedCents[assignment.lineId] ?? 0) + toCents(assignment.kg);
    items.push({ order_line_id: assignment.lineId, compartment: index + 1, planned_kg: fromCents(toCents(assignment.kg)) });
  });

  const assignedByLine: Record<string, number> = {};
  for (const line of lines) {
    const assigned = assignedCents[line.id] ?? 0;
    assignedByLine[line.id] = fromCents(assigned);
    const expected = toCents(line.quantity_kg);
    if (assigned !== expected) {
      lineErrors[line.id] =
        assigned < expected
          ? `Faltan ${formatKg(fromCents(expected - assigned))} por repartir.`
          : `Sobran ${formatKg(fromCents(assigned - expected))}.`;
    }
  }

  const ok = Object.keys(compartmentErrors).length === 0 && Object.keys(lineErrors).length === 0;
  return { compartmentErrors, lineErrors, assignedByLine, items: ok ? items : null };
}

/** ¿Es el reparto guardado igual al automático? (para abrir la edición en el modo adecuado). */
export function sameAllocation(a: LoadItemPayload[], b: LoadItemPayload[]): boolean {
  if (a.length !== b.length) return false;
  const key = (item: LoadItemPayload) => `${item.compartment}|${item.order_line_id}|${toCents(item.planned_kg)}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((value, index) => value === right[index]);
}

/** Porcentaje de ocupación (0–∞, redondeado a entero). */
export function occupancyPct(plannedKg: number, capacityKg: number): number {
  if (capacityKg <= 0) return 0;
  return Math.round((plannedKg / capacityKg) * 100);
}

/** Neto de báscula si hay bruto y tara válidos (bruto > tara); si no, `null`. */
export function netWeight(grossKg: number | null, tareKg: number | null): number | null {
  if (grossKg === null || tareKg === null || grossKg <= tareKg) return null;
  return fromCents(toCents(grossKg) - toCents(tareKg));
}

/** Diferencia relativa (en %) del neto de báscula respecto a la suma de compartimentos. */
export function netDifferencePct(netKg: number, compartmentsKg: number): number {
  if (compartmentsKg <= 0) return 0;
  return Math.round((Math.abs(netKg - compartmentsKg) / compartmentsKg) * 10000) / 100;
}

/** Umbral a partir del cual se avisa de que la báscula no cuadra con los compartimentos. */
export const NET_TOLERANCE_PCT = 2;
