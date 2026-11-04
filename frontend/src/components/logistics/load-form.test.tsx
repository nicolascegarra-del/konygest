import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoadForm, loadFieldFromApi } from "@/components/logistics/load-form";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { toIsoDate } from "@/lib/format";
import { renderWithQuery } from "@/test/query-wrapper";
import type { PendingOrder } from "@/types/fase3";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }) }));

const mockedApi = vi.mocked(api);

const TRUCKS = {
  items: [
    {
      id: "t-1",
      plate: "1234-ABC",
      carrier_id: null,
      carrier_name: "Propia",
      compartments: [10000, 8000, 6000],
      capacity_kg: 24000,
      notes: "",
      is_active: true,
      created_at: "2026-01-01T00:00:00Z",
    },
  ],
  total: 1,
  offset: 0,
  limit: 200,
};

const DRIVERS = {
  items: [{ id: "d-1", full_name: "Luis Conductor", phone: "", carrier_id: null, carrier_name: null, is_active: true, created_at: "2026-01-01T00:00:00Z" }],
  total: 1,
  offset: 0,
  limit: 200,
};

function pendingOrder(id: string, customer: string, lineId: string, kg: number): PendingOrder {
  return {
    id,
    number: `PED-${id}`,
    status: "confirmed",
    customer_id: `c-${id}`,
    customer_code: "C01",
    customer_name: customer,
    farm_id: `f-${id}`,
    farm_name: "La Loma",
    farm_city: "Lorca",
    sales_rep_id: null,
    sales_rep_name: null,
    requested_date: toIsoDate(),
    total_kg: kg,
    total_amount: 0,
    line_count: 1,
    has_manual_price: false,
    created_at: "2026-11-01T08:00:00Z",
    submitted_at: null,
    updated_at: "2026-11-01T08:00:00Z",
    lines: [{ id: lineId, item_id: "p-1", item_code: "P-CEB", item_name: "Cebo", quantity_kg: kg, farm_silo: "Silo 1" }],
  };
}

const PENDING = {
  items: [pendingOrder("a", "Granja Pérez", "l-a", 12000), pendingOrder("b", "Granja López", "l-b", 5000)],
  total: 2,
  offset: 0,
  limit: 100,
};

function setup() {
  mockedApi.get.mockImplementation(async (path: string) => {
    if (path === "/masters/trucks") return TRUCKS;
    if (path === "/masters/drivers") return DRIVERS;
    if (path === "/logistics/pending-orders") return PENDING;
    throw new Error(`GET inesperado: ${path}`);
  });
  renderWithQuery(<LoadForm />);
  return userEvent.setup();
}

async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("option", { name: /1234-ABC/ });
  await user.selectOptions(screen.getByLabelText("Camión *"), "t-1");
  await user.click(await screen.findByRole("button", { name: /Añadir PED-a/ }));
  await user.click(screen.getByRole("button", { name: /Añadir PED-b/ }));
}

describe("formulario de carga", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.post.mockResolvedValue({ id: "load-1", number: "CAR-2026-0001" });
  });

  it("con reparto automático no envía items y respeta el orden de descarga", async () => {
    const user = setup();
    await fillBasics(user);

    // Vista previa: la línea de 12.000 kg se parte en C1 y C2; la de 5.000 kg va a C3.
    const preview = screen.getByRole("list", { name: "Vista previa del reparto" });
    expect(within(preview).getAllByRole("listitem")).toHaveLength(3);
    expect(within(preview).getByText("2.000 kg / 8.000 kg")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Subir parada 2" }));
    await user.click(screen.getByRole("button", { name: "Crear carga" }));

    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledTimes(1));
    const [path, payload] = mockedApi.post.mock.calls[0] ?? [];
    expect(path).toBe("/loads");
    expect(payload).toEqual({
      load_date: toIsoDate(),
      truck_id: "t-1",
      driver_id: null,
      notes: "",
      stops: [
        { order_id: "b", sequence: 1 },
        { order_id: "a", sequence: 2 },
      ],
    });
    expect(payload).not.toHaveProperty("items");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/logistica/cargas/load-1"));
  });

  it("a mano valida la capacidad de cada compartimento y envía items", async () => {
    const user = setup();
    await fillBasics(user);
    await user.selectOptions(screen.getByLabelText("Conductor"), "d-1");
    await user.click(screen.getByRole("tab", { name: "Repartir a mano" }));

    // Se prefija con el reparto automático.
    expect(screen.getByLabelText("Kilos del compartimento 1")).toHaveValue("10000");
    expect(screen.getByLabelText("Kilos del compartimento 2")).toHaveValue("2000");
    expect(screen.getByLabelText("Kilos del compartimento 3")).toHaveValue("5000");

    // C2 tiene 8.000 kg de capacidad.
    await user.clear(screen.getByLabelText("Kilos del compartimento 1"));
    await user.type(screen.getByLabelText("Kilos del compartimento 1"), "3000");
    await user.clear(screen.getByLabelText("Kilos del compartimento 2"));
    await user.type(screen.getByLabelText("Kilos del compartimento 2"), "9000");
    expect(screen.getByText("Supera la capacidad del compartimento (8.000 kg).")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Crear carga" }));
    expect(await screen.findByText("Revisa el reparto en compartimentos: hay errores marcados.")).toBeInTheDocument();
    expect(mockedApi.post).not.toHaveBeenCalled();

    // Corregido: 4.000 + 8.000 = 12.000 kg de la línea A.
    await user.clear(screen.getByLabelText("Kilos del compartimento 1"));
    await user.type(screen.getByLabelText("Kilos del compartimento 1"), "4000");
    await user.clear(screen.getByLabelText("Kilos del compartimento 2"));
    await user.type(screen.getByLabelText("Kilos del compartimento 2"), "8000");
    await user.click(screen.getByRole("button", { name: "Crear carga" }));

    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledTimes(1));
    expect(mockedApi.post.mock.calls[0]?.[1]).toEqual({
      load_date: toIsoDate(),
      truck_id: "t-1",
      driver_id: "d-1",
      notes: "",
      stops: [
        { order_id: "a", sequence: 1 },
        { order_id: "b", sequence: 2 },
      ],
      items: [
        { order_line_id: "l-a", compartment: 1, planned_kg: 4000 },
        { order_line_id: "l-a", compartment: 2, planned_kg: 8000 },
        { order_line_id: "l-b", compartment: 3, planned_kg: 5000 },
      ],
    });
  });

  it("no envía si en automático no cabe todo", async () => {
    mockedApi.get.mockImplementation(async (path: string) => {
      if (path === "/masters/trucks") return TRUCKS;
      if (path === "/masters/drivers") return DRIVERS;
      if (path === "/logistics/pending-orders") {
        return { ...PENDING, items: [pendingOrder("a", "Granja Pérez", "l-a", 30000)], total: 1 };
      }
      throw new Error(`GET inesperado: ${path}`);
    });
    renderWithQuery(<LoadForm />);
    const user = userEvent.setup();
    await screen.findByRole("option", { name: /1234-ABC/ });
    await user.selectOptions(screen.getByLabelText("Camión *"), "t-1");
    await user.click(await screen.findByRole("button", { name: /Añadir PED-a/ }));
    expect(screen.getByText(/No cabe todo: faltan 6\.000 kg/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Crear carga" }));
    expect(await screen.findByText("No cabe todo en este camión: faltan 6.000 kg.")).toBeInTheDocument();
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it("muestra el error ORDER_NOT_PLANNABLE en la parada que indica el servidor", async () => {
    mockedApi.post.mockRejectedValueOnce(
      new ApiError({ status: 409, code: "ORDER_NOT_PLANNABLE", message: "El pedido PED-b ya va en la carga CAR-2026-0002.", field: "stops.1.order_id" }),
    );
    const user = setup();
    await fillBasics(user);
    await user.click(screen.getByRole("button", { name: "Crear carga" }));
    const stop = await screen.findByRole("listitem", { name: "Parada 2: Granja López" });
    expect(within(stop).getByText("El pedido PED-b ya va en la carga CAR-2026-0002.")).toBeInTheDocument();
    expect(screen.getByText(/^Ese pedido ya no se puede planificar/)).toBeInTheDocument();
  });

  it("traduce el field de la API a la parte del formulario", () => {
    expect(loadFieldFromApi("truck_id")).toEqual({ kind: "header", name: "truck_id" });
    expect(loadFieldFromApi("stops.3.order_id")).toEqual({ kind: "stop", index: 3 });
    expect(loadFieldFromApi("items.2")).toEqual({ kind: "item", index: 2 });
    expect(loadFieldFromApi("items")).toBeNull();
    expect(loadFieldFromApi(null)).toBeNull();
  });
});
