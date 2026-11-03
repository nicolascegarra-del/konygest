import { z } from "zod";

import { decimalPlaces, numberToInput, parseDecimal } from "@/lib/format";

import type { FarmSiloValue, MasterField, MasterFormValues, PriceLineValue } from "./types";

const REQUIRED = "Este campo es obligatorio.";

interface NumberRules {
  min?: number;
  max?: number;
  positive?: boolean;
  integer?: boolean;
  decimals?: number;
}

/**
 * Valida un número tecleado y devuelve el mensaje de error, o `null` si es correcto.
 * Se comparte entre los campos numéricos y las filas de las listas.
 */
export function numberError(value: number, rules: NumberRules): string | null {
  if (rules.positive && value <= 0) return "Debe ser mayor que 0.";
  if (rules.min !== undefined && value < rules.min) return `Debe ser como mínimo ${numberToInput(rules.min)}.`;
  if (rules.max !== undefined && value > rules.max) return `Debe ser como máximo ${numberToInput(rules.max)}.`;
  if (rules.integer && !Number.isInteger(value)) return "Debe ser un número entero.";
  const decimals = rules.integer ? 0 : (rules.decimals ?? 2);
  if (decimalPlaces(value) > decimals) return `Como máximo ${decimals} decimales.`;
  return null;
}

/**
 * Esquema de un número tecleado como texto (admite coma decimal). Devuelve el número,
 * o `null` si está vacío y no es obligatorio. Lo usan también los formularios de stock y fabricación.
 */
export function numberInput(rules: NumberRules & { required?: boolean }) {
  return z.string().transform((text, ctx): number | null => {
    if (!text.trim()) {
      if (rules.required) ctx.addIssue({ code: "custom", message: REQUIRED });
      return null;
    }
    const value = parseDecimal(text);
    if (value === null) {
      ctx.addIssue({ code: "custom", message: "Introduce un número válido." });
      return z.NEVER;
    }
    const error = numberError(value, rules);
    if (error) ctx.addIssue({ code: "custom", message: error });
    return value;
  });
}

/** Esquema de un campo: valida lo tecleado y lo transforma al valor que espera la API. */
function fieldSchema(field: MasterField): z.ZodType<unknown, unknown> {
  switch (field.type) {
    case "text":
    case "textarea": {
      const max = field.maxLength ?? (field.type === "textarea" ? 2000 : 200);
      return z
        .string()
        .trim()
        .max(max, `Como máximo ${max} caracteres.`)
        .refine((text) => !field.required || text.length > 0, REQUIRED)
        .refine((text) => field.type !== "text" || field.inputType !== "email" || !text || z.email().safeParse(text).success, {
          message: "Introduce un email válido.",
        })
        .transform((text) => {
          const value = field.type === "text" && field.uppercase ? text.toUpperCase() : text;
          return field.type === "text" && field.nullable && !value ? null : value;
        });
    }
    case "number":
      return numberInput(field);
    case "select":
    case "customer":
      return z.string().transform((value, ctx) => {
        if (!value) {
          if (field.required) ctx.addIssue({ code: "custom", message: "Elige una opción." });
          return null;
        }
        return value;
      });
    case "switch":
      return z.boolean();
    case "number-list":
      return z.array(z.string()).transform((rows, ctx) => {
        const values: number[] = [];
        rows.forEach((text, index) => {
          const value = parseDecimal(text);
          const error = value === null ? "valor no válido" : numberError(value, field);
          if (error) {
            ctx.addIssue({ code: "custom", message: `${field.itemLabel} ${index + 1}: ${error.toLowerCase()}` });
          } else if (value !== null) {
            values.push(value);
          }
        });
        if (field.minItems && rows.length < field.minItems) {
          ctx.addIssue({
            code: "custom",
            message: field.minItems === 1 ? `Añade al menos un ${field.itemLabel.toLowerCase()}.` : `Añade al menos ${field.minItems}.`,
          });
        }
        if (field.maxItems && rows.length > field.maxItems) {
          ctx.addIssue({ code: "custom", message: `Como máximo ${field.maxItems}.` });
        }
        return values;
      });
    case "price-lines":
      return z.array(z.custom<PriceLineValue>()).transform((rows, ctx) => {
        const lines: { item_id: string; price: number }[] = [];
        const seen = new Set<string>();
        rows.forEach((row, index) => {
          const price = parseDecimal(row.price);
          const error = !row.item_id
            ? "elige el artículo"
            : seen.has(row.item_id)
              ? "artículo repetido"
              : price === null
                ? "indica un precio válido"
                : numberError(price, { min: 0, decimals: 4 });
          if (error) {
            ctx.addIssue({ code: "custom", message: `Línea ${index + 1}: ${error.toLowerCase()}` });
            return;
          }
          seen.add(row.item_id);
          lines.push({ item_id: row.item_id, price: price as number });
        });
        return lines;
      });
    case "farm-silos":
      return z.array(z.custom<FarmSiloValue>()).transform((rows, ctx) => {
        const silos: { name: string; capacity_kg: number | null }[] = [];
        rows.forEach((row, index) => {
          const name = row.name.trim();
          const capacity = row.capacity_kg.trim() ? parseDecimal(row.capacity_kg) : null;
          const error = !name
            ? "indica el nombre"
            : name.length > 50
              ? "nombre demasiado largo"
              : row.capacity_kg.trim() && capacity === null
                ? "capacidad no válida"
                : capacity !== null
                  ? numberError(capacity, { positive: true, max: 1_000_000 })
                  : null;
          if (error) {
            ctx.addIssue({ code: "custom", message: `Silo ${index + 1}: ${error.toLowerCase()}` });
            return;
          }
          silos.push({ name, capacity_kg: capacity });
        });
        return silos;
      });
  }
}

/** Esquema Zod del formulario: entrada = valores editados, salida = cuerpo para la API. */
export function buildMasterSchema(fields: MasterField[]) {
  const shape: Record<string, z.ZodType<unknown, unknown>> = {};
  for (const field of fields) shape[field.name] = fieldSchema(field);
  return z.object(shape);
}

/** Valor inicial de cada campo: el del registro al editar o el predeterminado al dar de alta. */
export function toFormValues(fields: MasterField[], record: Record<string, unknown> | null): MasterFormValues {
  const values: MasterFormValues = {};
  for (const field of fields) {
    const current = record ? record[field.name] : undefined;
    switch (field.type) {
      case "text":
      case "textarea":
      case "customer":
        values[field.name] = typeof current === "string" ? current : "";
        break;
      case "select":
        values[field.name] = typeof current === "string" ? current : record ? "" : (field.defaultValue ?? "");
        break;
      case "number":
        values[field.name] =
          typeof current === "number" ? numberToInput(current) : record ? "" : numberToInput(field.defaultValue);
        break;
      case "switch":
        values[field.name] =
          typeof current === "boolean" ? current : field.name === "is_active" ? true : (field.defaultValue ?? false);
        break;
      case "number-list":
        values[field.name] = Array.isArray(current)
          ? current.map((value) => numberToInput(Number(value)))
          : Array.from({ length: record ? 0 : (field.minItems ?? 0) }, () => "");
        break;
      case "price-lines":
        values[field.name] = Array.isArray(current)
          ? (current as { item_id: string; price: number; item_code?: string; item_name?: string }[]).map((line) => ({
              item_id: line.item_id,
              price: numberToInput(line.price),
              label: line.item_name ? `${line.item_code ? `${line.item_code} · ` : ""}${line.item_name}` : undefined,
            }))
          : [];
        break;
      case "farm-silos":
        values[field.name] = Array.isArray(current)
          ? (current as { name: string; capacity_kg: number | null }[]).map((silo) => ({
              name: silo.name,
              capacity_kg: numberToInput(silo.capacity_kg),
            }))
          : [];
        break;
    }
  }
  return values;
}
