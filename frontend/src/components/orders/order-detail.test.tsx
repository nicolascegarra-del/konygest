import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OrderDetail } from "@/components/orders/order-detail";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { renderWithQuery } from "@/test/query-wrapper";
import type { OrderChecks, SalesOrderAction, SalesOrderDetail, SalesOrderStatus } from "@/types/fase2";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockedApi = vi.mocked(api);

function order(status: SalesOrderStatus, allowed: SalesOrderAction[], extra: Partial<SalesOrderDetail> = {}): SalesOrderDetail {
  return {
    id: "o-1",
    number: "PED-2026-0001",
    status,
    customer_id: "c-1",
    customer_code: "C01",
    customer_name: "Granja Pérez",
    farm_id: "f-1",
    farm_name: "La Loma",
    sales_rep_id: "u-1",
    sales_rep_name: "Ana Comercial",
    requested_date: "2026-11-05",
    total_kg: 12000,
    total_amount: 3480,
    line_count: 1,
    has_manual_price: true,
    created_at: "2026-11-03T08:00:00Z",
    submitted_at: "2026-11-03T08:10:00Z",
    updated_at: "2026-11-03T08:10:00Z",
    notes: "",
    status_reason: "",
    validated_by_name: null,
    validated_at: null,
    created_by_name: "Ana Comercial",
    allowed_actions: allowed,
    lines: [
      {
        id: "l-1",
        position: 0,
        item_id: "p-1",
        item_code: "P-CEB",
        item_name: "Cebo",
        quantity_kg: 12000,
        unit_price: 0.29,
        price_source: "manual",
        reference_price: 0.315,
        amount: 3480,
        farm_silo: "Silo 1",
        notes: "",
      },
    ],
    ...extra,
  };
}

const CHECKS: OrderChecks = {
  credit: { credit_limit: 5000, outstanding_amount: 2000, order_amount: 3480, available: -480, exceeded: true },
  prices: [
    { line_id: "l-1", item_code: "P-CEB", item_name: "Cebo", unit_price: 0.29, reference_price: 0.315, difference_pct: -7.94 },
  ],
  stock: [
    { item_id: "p-1", item_code: "P-CEB", item_name: "Cebo", requested_kg: 12000, stock_kg: 10000, committed_kg: 0, short: true },
  ],
};

function setup(detail: SalesOrderDetail) {
  mockedApi.get.mockImplementation(async (path: string) => {
    if (path === "/orders/o-1") return detail;
    if (path === "/orders/o-1/checks") return CHECKS;
    throw new Error(`GET inesperado: ${path}`);
  });
  renderWithQuery(<OrderDetail orderId="o-1" />);
  return { user: userEvent.setup() };
}

describe("ficha de pedido", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.post.mockResolvedValue(order("confirmed", []));
  });

  it("muestra solo las acciones de allowed_actions (borrador del comercial)", async () => {
    setup(order("draft", ["edit", "submit", "cancel"]));
    expect(await screen.findByRole("heading", { name: "Pedido PED-2026-0001" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Editar" })).toHaveAttribute("href", "/pedidos/o-1/editar");
    expect(screen.getByRole("button", { name: "Enviar a validar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar pedido" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Validar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rechazar" })).not.toBeInTheDocument();
  });

  it("sin acciones permitidas no muestra ningún botón de acción", async () => {
    setup(order("pending", []));
    await screen.findByRole("heading", { name: "Pedido PED-2026-0001" });
    for (const name of ["Editar", "Enviar a validar", "Validar", "Rechazar", "Cancelar pedido"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
    }
  });

  it("enseña las comprobaciones de riesgo, precio y stock", async () => {
    setup(order("pending", ["validate", "reject", "cancel"]));
    expect(await screen.findByText(/Supera el riesgo del cliente/)).toBeInTheDocument();
    expect(screen.getByText("Stock insuficiente")).toBeInTheDocument();
    expect(screen.getAllByText(/-7,94|−7,94/).length).toBeGreaterThan(0);
  });

  it("rechaza con motivo obligatorio", async () => {
    const { user } = setup(order("pending", ["validate", "reject", "cancel"]));
    await user.click(await screen.findByRole("button", { name: "Rechazar" }));
    await user.click(screen.getByRole("button", { name: "Rechazar pedido" }));
    expect(await screen.findByText("Indica el motivo.")).toBeInTheDocument();
    expect(mockedApi.post).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Motivo *"), "  Precio por debajo de tarifa  ");
    await user.click(screen.getByRole("button", { name: "Rechazar pedido" }));
    await waitFor(() =>
      expect(mockedApi.post).toHaveBeenCalledWith("/orders/o-1/reject", { reason: "Precio por debajo de tarifa" }),
    );
  });

  it("si se supera el riesgo, permite validar igualmente con force", async () => {
    mockedApi.post.mockRejectedValueOnce(
      new ApiError({ status: 409, code: "CREDIT_LIMIT_EXCEEDED", message: "Supera el límite de crédito en 480,00 €." }),
    );
    const { user } = setup(order("pending", ["validate", "reject", "cancel"]));
    await user.click(await screen.findByRole("button", { name: "Validar" }));
    await user.click(screen.getByRole("button", { name: "Validar pedido" }));

    expect(await screen.findByText("Supera el límite de crédito en 480,00 €.")).toBeInTheDocument();
    expect(mockedApi.post).toHaveBeenNthCalledWith(1, "/orders/o-1/validate", {});

    await user.click(screen.getByRole("button", { name: "Validar igualmente" }));
    await waitFor(() => expect(mockedApi.post).toHaveBeenNthCalledWith(2, "/orders/o-1/validate", { force: true }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Validar igualmente" })).not.toBeInTheDocument());
  });

  it("destaca el motivo de un pedido rechazado", async () => {
    setup(order("rejected", ["edit", "submit", "cancel"], { status_reason: "Falta el silo de destino" }));
    const alert = await screen.findByText("Falta el silo de destino");
    expect(alert.closest("[role=alert]")).toHaveTextContent("Pedido rechazado por oficina");
  });
});
