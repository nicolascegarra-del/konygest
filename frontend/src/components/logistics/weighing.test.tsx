import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WeighingPage } from "@/components/logistics/weighing";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { loadDetail } from "@/test/load-fixtures";
import { renderWithQuery } from "@/test/query-wrapper";
import type { MasterLookups } from "@/types/fase1";
import type { LoadDetail } from "@/types/fase3";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), blob: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const mockedApi = vi.mocked(api);

const LOOKUPS: MasterLookups = {
  vat_rates: [],
  payment_methods: [],
  price_lists: [],
  carriers: [],
  sales_reps: [],
  silos: [
    { id: "si-1", name: "Silo 1", code: "S1", kind: "silo" },
    { id: "si-2", name: "Silo 2", code: "S2", kind: "silo" },
  ],
  items: [],
};

/** Cebo (p-1) solo tiene stock en S1; Lechones (p-2) en S1 y S2 (no se sugiere silo). */
const STOCK: Record<string, { silo_id: string; quantity_kg: number }[]> = {
  "p-1": [{ silo_id: "si-1", quantity_kg: 15000 }],
  "p-2": [
    { silo_id: "si-1", quantity_kg: 3000 },
    { silo_id: "si-2", quantity_kg: 9000 },
  ],
};

function setup(detail: LoadDetail) {
  mockedApi.get.mockImplementation(async (path: string, query?: Record<string, unknown>) => {
    if (path === "/loads/l-1") return detail;
    if (path === "/masters/lookups") return LOOKUPS;
    if (path === "/stock/levels") {
      const levels = STOCK[String(query?.item_id)] ?? [];
      return { items: levels.map((level) => ({ ...level, item_id: query?.item_id })), total: levels.length, offset: 0, limit: 200 };
    }
    throw new Error(`GET inesperado: ${path}`);
  });
  renderWithQuery(<WeighingPage loadId="l-1" />);
  return userEvent.setup();
}

/** Espera a que lleguen los silos y el stock de ambos piensos (las opciones dicen «disponibles»). */
async function silosReady(): Promise<HTMLSelectElement[]> {
  const silos = (await screen.findAllByLabelText("Silo de origen *")) as HTMLSelectElement[];
  await waitFor(() => expect(within(silos[1]!).getAllByRole("option", { name: /disponibles/ })).toHaveLength(2));
  return silos;
}

describe("pantalla de pesada", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefija los kg reales, calcula el neto, avisa si no cuadra y envía el payload", async () => {
    const saved = loadDetail("loaded", []);
    saved.stops = saved.stops.map((stop, index) => ({ ...stop, delivery_note_number: `ALB-2026-000${index + 1}`, delivery_note_ready: true }));
    mockedApi.post.mockResolvedValue(saved);
    const user = setup(loadDetail("ready", ["load"]));

    const actuals = await screen.findAllByLabelText("Kg reales *");
    expect(actuals.map((input) => (input as HTMLInputElement).value)).toEqual(["10000", "5000"]);

    // Silo sugerido para el Cebo (único con stock) y stock visible en las opciones.
    const silos = await silosReady();
    expect(silos[0]).toHaveValue("si-1");
    expect(silos[1]).toHaveValue("");
    expect(within(silos[1]!).getByRole("option", { name: /S2 · Silo 2 — 9\.000\s+kg disponibles/ })).toBeInTheDocument();

    // Sin silo en el segundo compartimento: no deja registrar.
    await user.click(screen.getByRole("button", { name: "Registrar carga" }));
    expect(await screen.findByText("Elige el silo del que sale el pienso.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.selectOptions(silos[1]!, "si-2");
    await user.type(screen.getAllByLabelText("Lote")[1]!, "L-7");
    await user.clear(actuals[0]!);
    await user.type(actuals[0]!, "9980");

    await user.type(screen.getByLabelText("Bruto"), "31.000");
    await user.type(screen.getByLabelText("Tara"), "14200");
    expect(screen.getByTestId("net-weight")).toHaveTextContent("16.800 kg");
    // 16.800 frente a 14.980 de compartimentos: más del 2 %.
    expect(screen.getByText(/difiere un 12,15 %/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Registrar carga" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Registrar carga" }));

    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledTimes(1));
    expect(mockedApi.post).toHaveBeenCalledWith("/loads/l-1/load", {
      gross_kg: 31000,
      tare_kg: 14200,
      items: [
        { item_id: "li-1", actual_kg: 9980, silo_id: "si-1", lot: null },
        { item_id: "li-2", actual_kg: 5000, silo_id: "si-2", lot: "L-7" },
      ],
    });

    // Tras registrar, ofrece los albaranes.
    expect(await screen.findByText("Carga registrada")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Albarán (PDF)" })).toHaveLength(2);
  });

  it("sin báscula no envía bruto ni tara, y no avisa del neto", async () => {
    mockedApi.post.mockResolvedValue(loadDetail("loaded", []));
    const user = setup(loadDetail("ready", ["load"]));
    const silos = await silosReady();
    await user.selectOptions(silos[1]!, "si-2");
    expect(screen.getByTestId("net-weight")).toHaveTextContent("—");
    await user.click(screen.getByRole("button", { name: "Registrar carga" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Registrar carga" }));
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledTimes(1));
    const payload = mockedApi.post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("gross_kg");
    expect(payload).not.toHaveProperty("tare_kg");
  });

  it("explica INSUFFICIENT_STOCK y marca el silo del compartimento", async () => {
    mockedApi.post.mockRejectedValue(
      new ApiError({ status: 409, code: "INSUFFICIENT_STOCK", message: "S1 solo tiene 3.000 kg de Lechones.", field: "items.1.silo_id" }),
    );
    const user = setup(loadDetail("ready", ["load"]));
    const silos = await silosReady();
    await user.selectOptions(silos[1]!, "si-1");
    expect(screen.getByText("Ese silo solo tiene 3.000 kg de este pienso.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Registrar carga" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Registrar carga" }));

    expect(await screen.findByText(/^No hay stock suficiente en ese silo/)).toBeInTheDocument();
    expect(screen.getAllByText("S1 solo tiene 3.000 kg de Lechones.").length).toBeGreaterThan(0);
    expect(silos[1]).toHaveAttribute("aria-invalid", "true");
  });

  it("en una carga ya cargada solo muestra lo registrado", async () => {
    const detail = loadDetail("loaded", []);
    detail.items = detail.items.map((item) => ({ ...item, actual_kg: item.planned_kg - 20, silo_id: "si-1", silo_name: "Silo 1" }));
    setup(detail);
    expect(await screen.findByText("La pesada ya está registrada.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Kg reales *")).not.toBeInTheDocument();
    expect(screen.getByText("9.980 kg")).toBeInTheDocument();
  });
});
