import { describe, expect, it } from "vitest";

import { formatBytes, formatKg, formatPlainDate, formatPrice, parseDecimal, toIsoDate } from "@/lib/format";

// Intl usa espacio duro (U+00A0) entre la cifra y la unidad.
const nbsp = (text: string) => text.replace(/ /g, " ");

describe("formatKg", () => {
  it("sin decimales si la cantidad es entera, con separador de miles", () => {
    expect(formatKg(12500)).toBe(nbsp("12.500 kg"));
    expect(formatKg(1234)).toBe(nbsp("1.234 kg"));
    expect(formatKg(0)).toBe(nbsp("0 kg"));
    expect(formatKg(12500.0)).toBe(nbsp("12.500 kg"));
  });

  it("con 2 decimales cuando los tiene", () => {
    expect(formatKg(1234.5)).toBe(nbsp("1.234,50 kg"));
    expect(formatKg(0.25)).toBe(nbsp("0,25 kg"));
    // Redondea a 2 decimales (lo que guarda la BD).
    expect(formatKg(10.004)).toBe(nbsp("10 kg"));
    expect(formatKg(10.006)).toBe(nbsp("10,01 kg"));
  });

  it("negativos con signo menos y, si se pide, positivos con +", () => {
    expect(formatKg(-300)).toBe(nbsp("−300 kg"));
    expect(formatKg(300, { signed: true })).toBe(nbsp("+300 kg"));
    expect(formatKg(-2500.5, { signed: true })).toBe(nbsp("−2.500,50 kg"));
    expect(formatKg(0, { signed: true })).toBe(nbsp("0 kg"));
  });

  it("devuelve «—» sin valor", () => {
    expect(formatKg(null)).toBe("—");
    expect(formatKg(undefined)).toBe("—");
    expect(formatKg(Number.NaN)).toBe("—");
  });
});

describe("formatPrice", () => {
  it("€/kg con 2 a 4 decimales", () => {
    expect(formatPrice(0.3125)).toBe(nbsp("0,3125 €/kg"));
    expect(formatPrice(0.3)).toBe(nbsp("0,30 €/kg"));
    expect(formatPrice(0.312345)).toBe(nbsp("0,3123 €/kg"));
    expect(formatPrice(null)).toBe("—");
  });
});

describe("parseDecimal", () => {
  it("acepta coma decimal, punto decimal y miles con punto", () => {
    expect(parseDecimal("12,5")).toBe(12.5);
    expect(parseDecimal("12.5")).toBe(12.5);
    expect(parseDecimal("12.500")).toBe(12500);
    expect(parseDecimal("12.500,75")).toBe(12500.75);
    expect(parseDecimal(" 300 ")).toBe(300);
    expect(parseDecimal("-4,5")).toBe(-4.5);
  });

  it("devuelve null si no es un número", () => {
    expect(parseDecimal("")).toBeNull();
    expect(parseDecimal("abc")).toBeNull();
    expect(parseDecimal("1,2,3")).toBeNull();
  });
});

describe("fechas sin hora", () => {
  it("formatea YYYY-MM-DD como DD/MM/YYYY sin desfase horario", () => {
    expect(formatPlainDate("2026-11-03")).toBe("03/11/2026");
    expect(formatPlainDate(null)).toBe("—");
  });

  it("toIsoDate usa la fecha local", () => {
    expect(toIsoDate(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });
});

describe("formatBytes", () => {
  it("usa base 1024, coma decimal y espacio duro", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(2.3 * 1024 * 1024)).toBe("2,3 MB");
    expect(formatBytes(1500 * 1024 * 1024 * 1024)).toBe("1,5 TB");
  });

  it("devuelve «—» sin valor", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});
