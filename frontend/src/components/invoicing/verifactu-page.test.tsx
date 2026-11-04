import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VerifactuPage } from "@/components/invoicing/verifactu-page";
import { api } from "@/lib/api";
import { renderWithQuery } from "@/test/query-wrapper";
import type { VerifactuRecord, VerifactuVerifyResult } from "@/types/fase4";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockedApi = vi.mocked(api);

const RECORDS: VerifactuRecord[] = [
  {
    id: "vr-2",
    sequence: 2,
    record_type: "anulacion",
    invoice_id: "inv-1",
    invoice_number: "F-2026-0001",
    issue_date: "2026-11-04",
    invoice_type: "",
    total_tax: null,
    total_amount: null,
    generated_at: "2026-11-04T10:00:00Z",
    previous_hash: "a".repeat(64),
    hash: `bbbbbbbb${"0".repeat(52)}cccc`,
    send_status: "not_sent",
  },
  {
    id: "vr-1",
    sequence: 1,
    record_type: "alta",
    invoice_id: "inv-1",
    invoice_number: "F-2026-0001",
    issue_date: "2026-11-04",
    invoice_type: "F1",
    total_tax: 648,
    total_amount: 7128,
    generated_at: "2026-11-04T09:00:00Z",
    previous_hash: null,
    hash: "a".repeat(64),
    send_status: "not_sent",
  },
];

function setup(verify: VerifactuVerifyResult) {
  mockedApi.get.mockImplementation(async (path: string) => {
    if (path === "/verifactu/records") return { items: RECORDS, total: 2, offset: 0, limit: 25 };
    if (path === "/verifactu/verify") return verify;
    throw new Error(`GET inesperado: ${path}`);
  });
  renderWithQuery(<VerifactuPage />);
  return { user: userEvent.setup() };
}

describe("pantalla Verifactu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lista los registros con tipo, factura, huella abreviada y estado de envío", async () => {
    setup({ ok: true, records: 2, broken: [] });
    expect((await screen.findAllByText("Nº 2")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Anulación").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Alta · F1").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "F-2026-0001" })[0]).toHaveAttribute("href", "/facturacion/facturas/inv-1");
    expect(screen.getAllByText("bbbbbbbb…cccc").length).toBeGreaterThan(0);
    expect(screen.getAllByText("No enviado: envío a la AEAT pendiente de activar").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Copiar la huella del registro 1" }).length).toBeGreaterThan(0);
    // La comprobación no se lanza hasta pulsar el botón.
    expect(mockedApi.get).not.toHaveBeenCalledWith("/verifactu/verify", undefined, expect.anything());
  });

  it("cadena correcta en verde", async () => {
    const { user } = setup({ ok: true, records: 2, broken: [] });
    await user.click(await screen.findByRole("button", { name: /Comprobar la cadena/ }));
    expect(await screen.findByText(/Cadena correcta: 2 registros comprobados/)).toBeInTheDocument();
  });

  it("cadena rota en rojo con los registros que fallan", async () => {
    const { user } = setup({ ok: false, records: 2, broken: [{ sequence: 2, invoice_number: "F-2026-0001" }] });
    await user.click(await screen.findByRole("button", { name: /Comprobar la cadena/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Cadena rota: 1 de 2 registros no cuadran");
    expect(alert).toHaveTextContent("Registro nº 2 — F-2026-0001");
    await waitFor(() => expect(mockedApi.get).toHaveBeenCalledWith("/verifactu/verify", undefined, expect.anything()));
  });
});
