import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PendingInvoicingPage } from "@/components/invoicing/pending-page";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { useAuthStore } from "@/stores/auth-store";
import { invoice, invoicingMe, PENDING } from "@/test/invoice-fixtures";
import { renderWithQuery } from "@/test/query-wrapper";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockedApi = vi.mocked(api);

function setup(options: { readOnly?: boolean } = {}) {
  useAuthStore.setState({ user: invoicingMe(options), status: "authenticated" });
  mockedApi.get.mockImplementation(async (path: string) => {
    if (path === "/invoicing/pending") return { items: PENDING, total: PENDING.length, offset: 0, limit: 20 };
    throw new Error(`GET inesperado: ${path}`);
  });
  const result = renderWithQuery(<PendingInvoicingPage />);
  return { user: userEvent.setup(), ...result };
}

async function card(name: string) {
  const heading = await screen.findByText(name, { exact: false, selector: "[id^=pending-]" });
  return heading.closest("[aria-labelledby]") as HTMLElement;
}

describe("pendiente de facturar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.post.mockResolvedValue(invoice("draft", ["edit", "delete", "issue"], { id: "inv-9" }));
  });

  it("agrupa por cliente con sus pedidos entregados", async () => {
    setup();
    const perez = await card("Granja Pérez");
    expect(within(perez).getByText("PED-2026-0001")).toBeInTheDocument();
    expect(within(perez).getByText("PED-2026-0002")).toBeInTheDocument();
    expect(within(perez).getByText("Entregado el 02/11/2026")).toBeInTheDocument();
    expect(within(await card("Ganados López")).getByText("PED-2026-0003")).toBeInTheDocument();
  });

  it("crea el borrador solo con los pedidos marcados de ese cliente", async () => {
    const { user } = setup();
    const perez = await card("Granja Pérez");
    const create = within(perez).getByRole("button", { name: /Crear borrador/ });
    expect(create).toBeDisabled();

    await user.click(within(perez).getByRole("checkbox", { name: "Incluir el pedido PED-2026-0002" }));
    expect(within(perez).getByText(/1 pedido · 10\.000 kg/)).toBeInTheDocument();
    await user.click(create);

    await waitFor(() =>
      expect(mockedApi.post).toHaveBeenCalledWith("/invoices", { customer_id: "c-1", order_ids: ["o-2"] }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/facturacion/facturas/inv-9"));
  });

  it("«Seleccionar todos» marca todos los pedidos del cliente", async () => {
    const { user } = setup();
    const perez = await card("Granja Pérez");
    await user.click(within(perez).getByRole("checkbox", { name: "Seleccionar todos" }));
    await user.click(within(perez).getByRole("button", { name: /Crear borrador/ }));
    await waitFor(() =>
      expect(mockedApi.post).toHaveBeenCalledWith("/invoices", { customer_id: "c-1", order_ids: ["o-1", "o-2"] }),
    );
  });

  it("si un pedido ya no se puede facturar, avisa y no navega", async () => {
    mockedApi.post.mockRejectedValueOnce(new ApiError({ status: 409, code: "ORDER_NOT_INVOICEABLE", message: "x", field: "order_ids.0" }));
    const { user } = setup();
    const perez = await card("Granja Pérez");
    await user.click(within(perez).getByRole("checkbox", { name: "Incluir el pedido PED-2026-0001" }));
    await user.click(within(perez).getByRole("button", { name: /Crear borrador/ }));
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
  });

  it("factura todo el periodo con confirmación y muestra el resumen", async () => {
    mockedApi.post.mockResolvedValueOnce({
      created: [
        { ...invoice("draft", []), id: "inv-a", customer_name: "Granja Pérez", total: 7128 },
        { ...invoice("draft", []), id: "inv-b", customer_id: "c-2", customer_code: "C02", customer_name: "Ganados López", total: 2640 },
      ],
    });
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /Facturar todo el periodo/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Entregados desde"), "2026-10-01");
    await user.clear(within(dialog).getByLabelText("Entregados hasta *"));
    await user.type(within(dialog).getByLabelText("Entregados hasta *"), "2026-10-31");
    expect(mockedApi.post).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Crear borradores" }));

    await waitFor(() =>
      expect(mockedApi.post).toHaveBeenCalledWith("/invoices/bulk", { date_from: "2026-10-01", date_to: "2026-10-31" }),
    );
    expect(await screen.findByText("2 borradores creados")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ganados López/ })).toHaveAttribute("href", "/facturacion/facturas/inv-b");
  });

  it("en solo lectura no deja seleccionar ni crear", async () => {
    setup({ readOnly: true });
    await card("Granja Pérez");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Crear borrador/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Facturar todo el periodo/ })).not.toBeInTheDocument();
  });
});
