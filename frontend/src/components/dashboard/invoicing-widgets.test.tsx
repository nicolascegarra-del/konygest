import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InvoicingMonthWidget, monthChangePct, PendingInvoicingWidget } from "@/components/dashboard/invoicing-widgets";
import { api } from "@/lib/api";
import { PENDING } from "@/test/invoice-fixtures";
import { renderWithQuery } from "@/test/query-wrapper";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }));

const mockedApi = vi.mocked(api);

describe("widgets de facturación", () => {
  beforeEach(() => vi.clearAllMocks());

  it("variación respecto al mes anterior", () => {
    expect(monthChangePct(1100, 1000)).toBe(10);
    expect(monthChangePct(900, 1000)).toBe(-10);
    expect(monthChangePct(500, 0)).toBeNull();
  });

  it("facturación del mes: neto, comparación y nº de facturas", async () => {
    mockedApi.get.mockResolvedValue({
      month: "2026-11",
      invoiced_total: 12000,
      credit_total: 500,
      net_total: 11500,
      invoice_count: 7,
      previous_month_net: 10000,
    });
    renderWithQuery(<InvoicingMonthWidget />);
    expect(await screen.findByText(/11\.500,00/)).toBeInTheDocument();
    expect(screen.getByText(/\+1\.500,00\s€ \(\+15 %\) respecto a/)).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(mockedApi.get).toHaveBeenCalledWith("/invoicing/summary", { month: expect.stringMatching(/^\d{4}-\d{2}$/) }, expect.anything());
  });

  it("pendiente de facturar: clientes con su base estimada", async () => {
    mockedApi.get.mockResolvedValue({ items: PENDING, total: 2, offset: 0, limit: 5 });
    renderWithQuery(<PendingInvoicingWidget />);
    expect(await screen.findByText("Granja Pérez")).toBeInTheDocument();
    expect(screen.getByText("Pendiente de facturar (2)")).toBeInTheDocument();
    expect(mockedApi.get).toHaveBeenCalledWith("/invoicing/pending", { limit: 5 }, expect.anything());
  });
});
