import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreditNoteDialog, lineLimits } from "@/components/invoicing/credit-note-dialog";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { invoice } from "@/test/invoice-fixtures";
import { renderWithQuery } from "@/test/query-wrapper";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockedApi = vi.mocked(api);
const onClose = vi.fn();

function setup(options: { draft?: boolean } = {}) {
  const original = invoice("issued", ["credit_note", "cancel"]);
  const draft = options.draft
    ? invoice("draft", ["edit", "delete", "issue"], {
        id: "cn-1",
        kind: "credit_note",
        invoice_type: "R4",
        rectified_invoice_id: "inv-1",
        rectification_reason: "Precio mal aplicado",
        notes: "",
      })
    : undefined;
  renderWithQuery(<CreditNoteDialog invoice={original} draft={draft} onClose={onClose} />);
  return { user: userEvent.setup(), dialog: screen.getByRole("dialog") };
}

describe("diálogo de abono", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.post.mockResolvedValue(invoice("draft", [], { id: "cn-9", kind: "credit_note", invoice_type: "R1" }));
    mockedApi.put.mockResolvedValue(invoice("draft", [], { id: "cn-1", kind: "credit_note" }));
  });

  it("calcula lo que queda por abonar de cada línea", () => {
    const lines = invoice("issued", []).lines;
    expect(lineLimits(lines[0]!)).toMatchObject({ maxKg: 12000, maxAmount: 3480 });
    expect(lineLimits(lines[1]!)).toMatchObject({ maxKg: 9000, maxAmount: 2700, creditedKg: 1000, creditedAmount: 300 });
  });

  it("abono total: exige motivo y envía full con R1 por defecto", async () => {
    const { user, dialog } = setup();
    await user.click(within(dialog).getByRole("button", { name: "Crear borrador de abono" }));
    expect(await within(dialog).findByText("Indica el motivo.")).toBeInTheDocument();
    expect(mockedApi.post).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText("Motivo de la rectificación *"), "Devolución completa");
    await user.click(within(dialog).getByRole("button", { name: "Crear borrador de abono" }));
    await waitFor(() =>
      expect(mockedApi.post).toHaveBeenCalledWith("/invoices/inv-1/credit-note", {
        invoice_type: "R1",
        rectification_reason: "Devolución completa",
        full: true,
      }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/facturacion/facturas/cn-9"));
  });

  it("por líneas: kg devueltos en una y descuento en € en otra, con R4", async () => {
    const { user, dialog } = setup();
    await user.click(within(dialog).getByRole("radio", { name: /R4/ }));
    await user.click(within(dialog).getByRole("radio", { name: "Por líneas" }));
    // Lo ya abonado y el máximo de la segunda línea.
    expect(within(dialog).getByText("1.000 kg · 300,00 €")).toBeInTheDocument();
    expect(within(dialog).getByText("9.000 kg · 2.700,00 €")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Kg devueltos de Cebo cerdos"), "1.500");
    await user.selectOptions(within(dialog).getByLabelText("Cómo se abona Lechones"), "amount");
    await user.type(within(dialog).getByLabelText("Descuento en € de Lechones"), "120,5");
    await user.type(within(dialog).getByLabelText("Motivo de la rectificación *"), "Devolución y descuento");
    expect(within(dialog).getByText("−555,50 €")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Crear borrador de abono" }));

    await waitFor(() =>
      expect(mockedApi.post).toHaveBeenCalledWith("/invoices/inv-1/credit-note", {
        invoice_type: "R4",
        rectification_reason: "Devolución y descuento",
        lines: [
          { invoice_line_id: "l-1", quantity_kg: 1500 },
          { invoice_line_id: "l-2", amount: 120.5 },
        ],
      }),
    );
  });

  it("no deja pasar del máximo pendiente de una línea", async () => {
    const { user, dialog } = setup();
    await user.click(within(dialog).getByRole("radio", { name: "Por líneas" }));
    await user.type(within(dialog).getByLabelText("Kg devueltos de Lechones"), "9500");
    expect(within(dialog).getByText("Máximo 9.000 kg.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Motivo de la rectificación *"), "Devolución");
    await user.click(within(dialog).getByRole("button", { name: "Crear borrador de abono" }));
    expect(await within(dialog).findByText("Corrige los importes marcados.")).toBeInTheDocument();
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it("por líneas sin ningún valor pide al menos una línea", async () => {
    const { user, dialog } = setup();
    await user.click(within(dialog).getByRole("radio", { name: "Por líneas" }));
    await user.type(within(dialog).getByLabelText("Motivo de la rectificación *"), "Devolución");
    await user.click(within(dialog).getByRole("button", { name: "Crear borrador de abono" }));
    expect(await within(dialog).findByText(/al menos una línea/)).toBeInTheDocument();
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it("explica CREDIT_EXCEEDS_INVOICE sin cerrar el diálogo", async () => {
    mockedApi.post.mockRejectedValueOnce(
      new ApiError({ status: 409, code: "CREDIT_EXCEEDS_INVOICE", message: "Supera en 10,00 € lo pendiente." }),
    );
    const { user, dialog } = setup();
    await user.type(within(dialog).getByLabelText("Motivo de la rectificación *"), "Devolución");
    await user.click(within(dialog).getByRole("button", { name: "Crear borrador de abono" }));
    expect(await within(dialog).findByText("Supera en 10,00 € lo pendiente.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("al editar un borrador de abono envía PUT con las líneas", async () => {
    const { user, dialog } = setup({ draft: true });
    expect(within(dialog).getByRole("radio", { name: /R4/ })).toBeChecked();
    expect(within(dialog).getByLabelText("Motivo de la rectificación *")).toHaveValue("Precio mal aplicado");
    await user.type(within(dialog).getByLabelText("Kg devueltos de Cebo cerdos"), "100");
    await user.click(within(dialog).getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() =>
      expect(mockedApi.put).toHaveBeenCalledWith("/invoices/cn-1", {
        lines: [{ invoice_line_id: "l-1", quantity_kg: 100 }],
        rectification_reason: "Precio mal aplicado",
        invoice_type: "R4",
        notes: "",
        issue_date: "2026-11-04",
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
