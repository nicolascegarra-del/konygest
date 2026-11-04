import { describe, expect, it } from "vitest";

import { formatKg } from "@/lib/format";
import { autoAllocate, netDifferencePct, netWeight, occupancyPct, sameAllocation, validateManualAllocation } from "@/lib/loads";

describe("reparto automático en compartimentos", () => {
  it("rellena en orden y parte una línea que no cabe en un compartimento", () => {
    const result = autoAllocate(
      [10000, 8000, 6000],
      [{ order_id: "o-1", lines: [{ id: "l-1", quantity_kg: 12000 }] }],
    );
    expect(result.fits).toBe(true);
    expect(result.missingKg).toBe(0);
    expect(result.items).toEqual([
      { order_line_id: "l-1", compartment: 1, planned_kg: 10000 },
      { order_line_id: "l-1", compartment: 2, planned_kg: 2000 },
    ]);
  });

  it("no mezcla líneas: la siguiente empieza en un compartimento nuevo aunque sobre sitio", () => {
    const result = autoAllocate(
      [10000, 10000, 10000],
      [
        { order_id: "o-1", lines: [{ id: "l-1", quantity_kg: 4000 }, { id: "l-2", quantity_kg: 3000 }] },
        { order_id: "o-2", lines: [{ id: "l-3", quantity_kg: 2500.5 }] },
      ],
    );
    expect(result.items).toEqual([
      { order_line_id: "l-1", compartment: 1, planned_kg: 4000 },
      { order_line_id: "l-2", compartment: 2, planned_kg: 3000 },
      { order_line_id: "l-3", compartment: 3, planned_kg: 2500.5 },
    ]);
    expect(result.fits).toBe(true);
  });

  it("si no cabe todo, indica los kilos que faltan (aunque la capacidad total sobre)", () => {
    // 3 líneas en 2 compartimentos: la tercera no tiene compartimento libre.
    const result = autoAllocate(
      [10000, 10000],
      [
        { order_id: "o-1", lines: [{ id: "l-1", quantity_kg: 1000 }] },
        { order_id: "o-2", lines: [{ id: "l-2", quantity_kg: 1000 }, { id: "l-3", quantity_kg: 1500 }] },
      ],
    );
    expect(result.fits).toBe(false);
    expect(result.missingKg).toBe(1500);
    expect(result.items).toHaveLength(2);
  });

  it("si una línea se queda a medias, cuenta lo que falta", () => {
    const result = autoAllocate([5000, 5000], [{ order_id: "o-1", lines: [{ id: "l-1", quantity_kg: 12000.25 }] }]);
    expect(result.fits).toBe(false);
    expect(result.missingKg).toBe(2000.25);
    expect(result.items.map((item) => item.planned_kg)).toEqual([5000, 5000]);
  });

  it("respeta el orden de las paradas", () => {
    const result = autoAllocate(
      [6000, 6000],
      [
        { order_id: "o-2", lines: [{ id: "l-2", quantity_kg: 6000 }] },
        { order_id: "o-1", lines: [{ id: "l-1", quantity_kg: 6000 }] },
      ],
    );
    expect(result.items.map((item) => item.order_line_id)).toEqual(["l-2", "l-1"]);
  });

  it("sin paradas no reparte nada y cabe", () => {
    expect(autoAllocate([10000], [])).toEqual({ items: [], missingKg: 0, fits: true });
  });
});

describe("reparto a mano", () => {
  const lines = [
    { id: "l-1", quantity_kg: 12000 },
    { id: "l-2", quantity_kg: 5000 },
  ];

  it("acepta un reparto correcto y devuelve los items", () => {
    const result = validateManualAllocation(
      [10000, 8000, 6000],
      lines,
      [
        { lineId: "l-1", kg: 10000 },
        { lineId: "l-1", kg: 2000 },
        { lineId: "l-2", kg: 5000 },
      ],
      formatKg,
    );
    expect(result.items).toEqual([
      { order_line_id: "l-1", compartment: 1, planned_kg: 10000 },
      { order_line_id: "l-1", compartment: 2, planned_kg: 2000 },
      { order_line_id: "l-2", compartment: 3, planned_kg: 5000 },
    ]);
  });

  it("marca el compartimento que supera su capacidad y la línea que no cuadra", () => {
    const result = validateManualAllocation(
      [10000, 8000, 6000],
      lines,
      [{ lineId: "l-1", kg: 12000 }, undefined, { lineId: "l-2", kg: 5000 }],
      formatKg,
    );
    expect(result.items).toBeNull();
    expect(result.compartmentErrors[0]).toBe(`Supera la capacidad del compartimento (${formatKg(10000)}).`);
    expect(result.lineErrors["l-1"]).toBe(`Faltan ${formatKg(12000)} por repartir.`);
  });

  it("avisa de kilos sobrantes, de kilos sin línea y de líneas sin kilos", () => {
    const result = validateManualAllocation(
      [10000, 8000, 6000],
      lines,
      [{ lineId: "l-1", kg: 10000 }, { lineId: "l-1", kg: 3000 }, { lineId: "", kg: 5000 }],
      formatKg,
    );
    expect(result.lineErrors["l-1"]).toBe(`Sobran ${formatKg(1000)}.`);
    expect(result.compartmentErrors[2]).toBe("Elige qué línea va en este compartimento.");

    const empty = validateManualAllocation([10000], [lines[1]!], [{ lineId: "l-2", kg: null }], formatKg);
    expect(empty.compartmentErrors[0]).toBe("Indica los kilos (mayor que 0).");
  });
});

describe("utilidades de carga", () => {
  it("compara repartos sin importar el orden", () => {
    const a = [
      { order_line_id: "l-1", compartment: 1, planned_kg: 10000 },
      { order_line_id: "l-2", compartment: 2, planned_kg: 500 },
    ];
    expect(sameAllocation(a, [...a].reverse())).toBe(true);
    expect(sameAllocation(a, [{ ...a[0]!, planned_kg: 9999 }, a[1]!])).toBe(false);
  });

  it("calcula ocupación, neto y diferencia con la báscula", () => {
    expect(occupancyPct(18000, 24000)).toBe(75);
    expect(occupancyPct(1, 0)).toBe(0);
    expect(netWeight(38420, 14200)).toBe(24220);
    expect(netWeight(10000, 12000)).toBeNull();
    expect(netWeight(null, 12000)).toBeNull();
    expect(netDifferencePct(24220, 24000)).toBeCloseTo(0.92, 2);
    expect(netDifferencePct(16000, 15000)).toBeCloseTo(6.67, 2);
  });
});
