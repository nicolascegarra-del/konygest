import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InvoiceDetailView } from "@/components/invoicing/invoice-detail";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { useAuthStore } from "@/stores/auth-store";
import { invoice, invoicingMe } from "@/test/invoice-fixtures";
import { renderWithQuery } from "@/test/query-wrapper";
import type { InvoiceDetail } from "@/types/fase4";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), blob: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockedApi = vi.mocked(api);
const ACTION_NAMES = ["Emitir", "Editar", "Crear abono", "Anular", "Borrar"];

function setup(detail: InvoiceDetail, options: { readOnly?: boolean } = {}) {
  useAuthStore.setState({ user: invoicingMe(options), status: "authenticated" });
  mockedApi.get.mockImplementation(async (path: string) => {
    if (path === `/invoices/${detail.id}`) return detail;
    if (path === "/invoicing/pending") return { items: [], total: 0, offset: 0, limit: 1 };
    throw new Error(`GET inesperado: ${path}`);
  });
  renderWithQuery(<InvoiceDetailView invoiceId={detail.id} />);
  return { user: userEvent.setup() };
}

describe("ficha de factura", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("un borrador muestra solo las acciones de allowed_actions y sin PDF", async () => {
    setup(invoice("draft", ["edit", "delete", "issue"]));
    expect(await screen.findByRole("heading", { name: "Borrador de factura" })).toBeInTheDocument();
    for (const name of ["Emitir", "Editar", "Borrar"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crear abono" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Anular" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ver PDF" })).not.toBeInTheDocument();
  });

  it("una emitida enseña PDF, líneas con albarán, IVA, vencimientos y Verifactu", async () => {
    setup(invoice("issued", ["credit_note", "cancel"]));
    expect(await screen.findByRole("heading", { name: "Factura F-2026-0001" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ver PDF" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crear abono" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anular" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Emitir" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Albarán ALB-2026-0001/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("B12345678").length).toBeGreaterThan(0);
    expect(screen.getByText("04/12/2026")).toBeInTheDocument();
    expect(screen.getByText("A".repeat(64))).toBeInTheDocument();
    expect(screen.getByText("Primer registro de la cadena")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cotejar en la sede de la AEAT" })).toHaveAttribute(
      "href",
      expect.stringContaining("ValidarQR"),
    );
  });

  it("sin acciones permitidas o en solo lectura no hay botones de acción", async () => {
    setup(invoice("draft", ["edit", "delete", "issue"]), { readOnly: true });
    await screen.findByRole("heading", { name: "Borrador de factura" });
    for (const name of ACTION_NAMES) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });

  it("emite tras confirmar, avisando de que no se podrá modificar", async () => {
    mockedApi.post.mockResolvedValue(invoice("issued", []));
    const { user } = setup(invoice("draft", ["edit", "delete", "issue"]));
    await user.click(await screen.findByRole("button", { name: "Emitir" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/no se puede modificar; se registra en Verifactu/)).toBeInTheDocument();
    expect(mockedApi.post).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Emitir factura" }));
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledWith("/invoices/inv-1/issue", {}));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("si faltan datos fiscales de la empresa, enlaza a Ajustes → Empresa", async () => {
    mockedApi.post.mockRejectedValue(
      new ApiError({ status: 409, code: "COMPANY_FISCAL_DATA_MISSING", message: "x", field: "address" }),
    );
    const { user } = setup(invoice("draft", ["issue"]));
    await user.click(await screen.findByRole("button", { name: "Emitir" }));
    await user.click(screen.getByRole("button", { name: "Emitir factura" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Faltan datos fiscales de la empresa");
    expect(alert).toHaveTextContent("Falta la dirección de la empresa.");
    expect(within(alert).getByRole("link", { name: /Ajustes → Empresa/ })).toHaveAttribute("href", "/ajustes/empresa");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("si el cliente no tiene NIF, enlaza a su ficha", async () => {
    mockedApi.post.mockRejectedValue(new ApiError({ status: 409, code: "CUSTOMER_TAX_ID_MISSING", message: "x" }));
    const { user } = setup(invoice("draft", ["issue"]));
    await user.click(await screen.findByRole("button", { name: "Emitir" }));
    await user.click(screen.getByRole("button", { name: "Emitir factura" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("link", { name: "Abrir la ficha del cliente" })).toHaveAttribute("href", "/maestros/clientes/c-1");
  });

  it("explica la fecha fuera de orden dentro del diálogo", async () => {
    mockedApi.post.mockRejectedValue(new ApiError({ status: 409, code: "ISSUE_DATE_OUT_OF_ORDER", message: "x" }));
    const { user } = setup(invoice("draft", ["issue"]));
    await user.click(await screen.findByRole("button", { name: "Emitir" }));
    await user.click(screen.getByRole("button", { name: "Emitir factura" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("anterior a la de la última factura emitida");
  });

  it("anula con motivo obligatorio y explica HAS_CREDIT_NOTES", async () => {
    mockedApi.post.mockRejectedValueOnce(new ApiError({ status: 409, code: "HAS_CREDIT_NOTES", message: "x" }));
    const { user } = setup(invoice("issued", ["credit_note", "cancel"]));
    await user.click(await screen.findByRole("button", { name: "Anular" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/registro de anulación en Verifactu/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Anular factura" }));
    expect(await within(dialog).findByText("Indica el motivo.")).toBeInTheDocument();
    expect(mockedApi.post).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText("Motivo *"), "Cliente equivocado");
    await user.click(within(dialog).getByRole("button", { name: "Anular factura" }));
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledWith("/invoices/inv-1/cancel", { reason: "Cliente equivocado" }));
    expect(await within(dialog).findByText(/tiene abonos emitidos/)).toBeInTheDocument();
  });

  it("borra el borrador tras confirmar y vuelve al listado", async () => {
    mockedApi.delete.mockResolvedValue(undefined);
    const { user } = setup(invoice("draft", ["edit", "delete", "issue"]));
    await user.click(await screen.findByRole("button", { name: "Borrar" }));
    await user.click(screen.getByRole("button", { name: "Borrar borrador" }));
    await waitFor(() => expect(mockedApi.delete).toHaveBeenCalledWith("/invoices/inv-1"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/facturacion/facturas"));
  });

  it("edita los pedidos del borrador", async () => {
    mockedApi.put.mockResolvedValue(invoice("draft", []));
    const { user } = setup(invoice("draft", ["edit", "delete", "issue"]));
    await user.click(await screen.findByRole("button", { name: "Editar" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox", { name: "Incluir el pedido PED-2026-0001" }));
    await user.click(within(dialog).getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() =>
      expect(mockedApi.put).toHaveBeenCalledWith("/invoices/inv-1", { order_ids: ["o-2"], notes: "", issue_date: "2026-11-04" }),
    );
  });

  it("un abono enlaza a la factura que rectifica", async () => {
    setup(
      invoice("issued", [], {
        id: "cn-1",
        kind: "credit_note",
        number: "R-2026-0001",
        invoice_type: "R1",
        total: -330,
        rectified_invoice_id: "inv-1",
        rectified_number: "F-2026-0001",
        rectification_reason: "Devolución de 1.000 kg",
      }),
    );
    expect(await screen.findByRole("heading", { name: "Abono R-2026-0001" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "F-2026-0001" })).toHaveAttribute("href", "/facturacion/facturas/inv-1");
    expect(screen.getByText("Devolución de 1.000 kg")).toBeInTheDocument();
    expect(screen.getAllByText("−330,00 €").length).toBeGreaterThan(0);
  });
});
