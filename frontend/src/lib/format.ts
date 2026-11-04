const dateFormatter = new Intl.DateTimeFormat("es-ES", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("es-ES", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Fecha en formato DD/MM/YYYY (zona horaria del navegador). Devuelve "—" si no hay valor. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
}

/** Fecha y hora: DD/MM/YYYY, HH:mm. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateTimeFormatter.format(date);
}

/** Iniciales (máx. 2) para avatares. */
export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase());
  return letters.join("") || "?";
}

const kgFormatter = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 2, useGrouping: true });
const kgFormatterFixed = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });
const priceFormatter = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 4, useGrouping: true });
const moneyFormatter = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", useGrouping: true });
const percentFormatter = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/**
 * Formatea una cantidad en kilos al estilo es-ES.
 * Sin decimales si la cantidad es entera; con 2 decimales si los tiene.
 * @param value - Kilos (puede ser negativo).
 * @param options.signed - Antepone «+» a las cantidades positivas (los movimientos de stock).
 * @returns Por ejemplo «12.500 kg», «1.234,50 kg», «−300 kg». «—» si no hay valor.
 */
export function formatKg(value: number | null | undefined, options: { signed?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  const absolute = Math.abs(rounded);
  const text = Number.isInteger(absolute) ? kgFormatter.format(absolute) : kgFormatterFixed.format(absolute);
  // Signo menos tipográfico (U+2212): se lee mejor que el guion y no depende del color.
  const sign = rounded < 0 ? "−" : options.signed && rounded > 0 ? "+" : "";
  return `${sign}${text} kg`;
}

/**
 * Formatea un precio por kilo (€/kg) con un mínimo de 2 y un máximo de 4 decimales.
 * @returns Por ejemplo «0,3125 €/kg». «—» si no hay precio.
 */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${priceFormatter.format(value)} €/kg`;
}

/** Importe en euros: «1.234,50 €». «—» si no hay valor. */
export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return moneyFormatter.format(value);
}

/** Porcentaje: «21 %», «5,2 %». */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${percentFormatter.format(value)} %`;
}

/**
 * Fecha sin hora de la API (`YYYY-MM-DD`) en DD/MM/YYYY, sin pasar por zonas horarias
 * (con `new Date("2026-11-03")` en UTC-X se mostraría el día anterior).
 */
export function formatPlainDate(value: string | null | undefined): string {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return "—";
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/** Fecha local de hoy (o de `date`) como `YYYY-MM-DD`, para enviar a la API. */
export function toIsoDate(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Convierte lo que teclea el usuario en un número. Acepta coma decimal («12,5»), punto decimal
 * («12.5») y separador de miles con coma decimal («12.500,5»). Un número con puntos cada tres
 * cifras y sin coma («12.500») se toma como miles, que es como se escribe en España.
 * @returns El número, o `null` si el texto está vacío o no es un número.
 */
export function parseDecimal(text: string): number | null {
  let clean = text.trim().replace(/\s/g, "").replace(/−/g, "-");
  if (!clean) return null;
  if (clean.includes(",")) {
    clean = clean.replace(/\./g, "").replace(",", ".");
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(clean)) {
    clean = clean.replace(/\./g, "");
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(clean)) return null;
  const value = Number(clean);
  return Number.isFinite(value) ? value : null;
}

/** Número de la API para rellenar un campo de texto con coma decimal («12,5»). */
export function numberToInput(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return String(value).replace(".", ",");
}

/** Cifras decimales que tiene el número tecleado (para validar la precisión). */
export function decimalPlaces(value: number): number {
  if (Number.isInteger(value)) return 0;
  const text = value.toString();
  if (text.includes("e-")) return Number(text.split("e-")[1] ?? 0);
  return text.split(".")[1]?.length ?? 0;
}

const bytesFormatter = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1, useGrouping: true });
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Tamaño de fichero legible en es-ES (base 1024).
 * @param value - Bytes.
 * @returns Por ejemplo «512 B», «1,5 KB», «2,3 MB». «—» si no hay valor.
 */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return "—";
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(size)) : bytesFormatter.format(size);
  // Espacio duro: la cifra y la unidad no se separan al partir la línea.
  return `${text} ${BYTE_UNITS[unit]}`;
}
