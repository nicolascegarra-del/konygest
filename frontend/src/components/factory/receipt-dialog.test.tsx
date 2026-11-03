import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { computeNet, ReceiptDialog } from "@/components/factory/receipt-dialog";
import { api } from "@/lib/api";
import { formatKg } from "@/lib/format";
import { renderWithQuery } from "@/test/query-wrapper";
import type { MasterLookups } from "@/types/fase1";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockedApi = vi.mocked(api);

const LOOKUPS: MasterLookups = {
  vat_rates: [],
  payment_methods: [],
  price_lists: [],
  carriers: [],
  sales_reps: [],
  silos: [{ id: "silo-1", name: "Silo 1", code: "S1", kind: "silo" }],
  items: [
    { id: "mp-1", name: "Maíz", code: "MP01", kind: "raw_material" },
    { id: "pt-1", name: "Pienso cerdo engorde", code: "P01", kind: "product" },
  ],
};

function setup() {
  const onClose = vi.fn();
  const view = renderWithQuery(<ReceiptDialog onClose={onClose} />);
  return { onClose, user: userEvent.setup(), ...view };
}

async function fillBase(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("option", { name: "MP01 · Maíz" });
  await user.selectOptions(screen.getByLabelText("Materia prima *"), "mp-1");
  await user.selectOptions(screen.getByLabelText("Silo o almacén *"), "silo-1");
}

describe("entrada de materia prima", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.get.mockResolvedValue(LOOKUPS);
    mockedApi.post.mockResolvedValue({ id: "r1", number: "EM-2026-0001", net_kg: 12499.5 });
  });

  it("computeNet resta la tara al bruto con coma decimal", () => {
    expect(computeNet("25.000", "12.500,5")).toBe(12499.5);
    expect(computeNet("", "100")).toBeNull();
  });

  it("solo ofrece materias primas", async () => {
    setup();
    await screen.findByRole("option", { name: "MP01 · Maíz" });
    expect(screen.queryByRole("option", { name: /Pienso cerdo/ })).not.toBeInTheDocument();
  });

  it("calcula el neto en vivo", async () => {
    const { user } = setup();
    const net = screen.getByTestId("receipt-net");
    expect(net).toHaveTextContent("—");

    await user.type(screen.getByLabelText("Peso bruto *"), "25.000");
    await user.type(screen.getByLabelText("Tara *"), "12.500,5");
    expect(net.textContent).toMatch(/^12.499,50/);
    expect(net.textContent).toBe(formatKg(12499.5));
  });

  it("da error y no envía si la tara es mayor o igual que el bruto", async () => {
    const { user } = setup();
    await fillBase(user);

    await user.type(screen.getByLabelText("Peso bruto *"), "10000");
    await user.type(screen.getByLabelText("Tara *"), "10000");
    await user.click(screen.getByRole("button", { name: "Registrar entrada" }));

    expect(await screen.findByText("La tara debe ser menor que el peso bruto.")).toBeInTheDocument();
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it("exige materia prima, silo y pesos", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Registrar entrada" }));

    expect(await screen.findByText("Elige la materia prima.")).toBeInTheDocument();
    expect(screen.getByText("Elige el silo o almacén.")).toBeInTheDocument();
    expect(screen.getAllByText("Este campo es obligatorio.")).toHaveLength(2);
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it("envía la entrada con números y matrícula en mayúsculas", async () => {
    const { user, onClose } = setup();
    await fillBase(user);

    await user.type(screen.getByLabelText("Proveedor"), "Cereales del Sur");
    await user.type(screen.getByLabelText("Albarán"), "A-889");
    await user.type(screen.getByLabelText("Matrícula"), "1234bcd");
    await user.type(screen.getByLabelText("Peso bruto *"), "25.000");
    await user.type(screen.getByLabelText("Tara *"), "12.500,5");
    await user.click(screen.getByRole("button", { name: "Registrar entrada" }));

    await waitFor(() =>
      expect(mockedApi.post).toHaveBeenCalledWith("/stock/receipts", {
        item_id: "mp-1",
        silo_id: "silo-1",
        supplier: "Cereales del Sur",
        delivery_note: "A-889",
        plate: "1234BCD",
        gross_kg: 25000,
        tare_kg: 12500.5,
        notes: "",
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
