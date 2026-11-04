import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LoadDetailView } from "@/components/logistics/load-detail";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { loadDetail } from "@/test/load-fixtures";
import { renderWithQuery } from "@/test/query-wrapper";
import type { LoadDetail } from "@/types/fase3";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), blob: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const mockedApi = vi.mocked(api);

function setup(detail: LoadDetail) {
  mockedApi.get.mockImplementation(async (path: string) => {
    if (path === "/loads/l-1") return detail;
    throw new Error(`GET inesperado: ${path}`);
  });
  renderWithQuery(<LoadDetailView loadId="l-1" />);
  return userEvent.setup();
}

function fakeWindow() {
  return { closed: false, close: vi.fn(), location: { href: "" } };
}

describe("ficha de carga", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.post.mockResolvedValue(loadDetail("ready", []));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("planificada: editar, emitir, cancelar y orden de carga; nada de pesada ni entrega", async () => {
    setup(loadDetail("planned", ["edit", "release", "cancel"]));
    expect(await screen.findByRole("heading", { name: "Carga CAR-2026-0001" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Editar" })).toHaveAttribute("href", "/logistica/cargas/l-1/editar");
    expect(screen.getByRole("button", { name: "Emitir a fábrica" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar carga" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Orden de carga (PDF)" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Registrar pesada" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Devolver a planificación" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirmar entrega" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Albarán (PDF)" })).not.toBeInTheDocument();

    // Paradas en orden con enlace al pedido y REGA.
    const first = screen.getByRole("listitem", { name: "Parada 1: Granja Pérez" });
    expect(within(first).getByRole("link", { name: "Pedido PED-2026-0001" })).toHaveAttribute("href", "/pedidos/o-a");
    expect(within(first).getByText(/REGA ES300240000001/)).toBeInTheDocument();
  });

  it("lista para cargar: devolver y registrar pesada, sin editar", async () => {
    setup(loadDetail("ready", ["unrelease", "load", "cancel"]));
    await screen.findByRole("heading", { name: "Carga CAR-2026-0001" });
    expect(screen.getByRole("link", { name: "Registrar pesada" })).toHaveAttribute("href", "/fabrica/cargas/l-1");
    expect(screen.getByRole("button", { name: "Devolver a planificación" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Editar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Emitir a fábrica" })).not.toBeInTheDocument();
  });

  it("emite la orden de carga a fábrica tras confirmar", async () => {
    const user = setup(loadDetail("planned", ["edit", "release", "cancel"]));
    await user.click(await screen.findByRole("button", { name: "Emitir a fábrica" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Emitir a fábrica" }));
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledWith("/loads/l-1/release"));
  });

  it("cargada: albarán por parada y confirmar entrega solo en las pendientes", async () => {
    const detail = loadDetail("loaded", ["deliver"], { loaded_at: "2026-11-05T07:00:00Z" });
    detail.stops = detail.stops.map((stop, index) => ({
      ...stop,
      delivery_note_number: `ALB-2026-000${index + 1}`,
      delivery_note_ready: true,
      delivered_at: index === 0 ? "2026-11-05T09:00:00Z" : null,
      received_by: index === 0 ? "Pepe" : "",
    }));
    const user = setup(detail);
    await screen.findByRole("heading", { name: "Carga CAR-2026-0001" });
    expect(screen.getAllByRole("button", { name: "Albarán (PDF)" })).toHaveLength(2);
    const buttons = screen.getAllByRole("button", { name: "Confirmar entrega" });
    expect(buttons).toHaveLength(1);
    expect(within(screen.getByRole("listitem", { name: "Parada 1: Granja Pérez" })).getByText(/recibió Pepe/)).toBeInTheDocument();

    await user.click(buttons[0]!);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Recibido por"), "  Ana López ");
    await user.click(within(dialog).getByRole("button", { name: "Confirmar entrega" }));
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledTimes(1));
    const [path, payload] = mockedApi.post.mock.calls[0] ?? [];
    expect(path).toBe("/loads/l-1/stops/s-b/deliver");
    expect(payload).toMatchObject({ received_by: "Ana López" });
    expect(payload).toHaveProperty("delivered_at");
  });

  it("abre el PDF descargado con el token en una pestaña nueva", async () => {
    const win = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:pdf-1"), revokeObjectURL: vi.fn() }));
    mockedApi.blob.mockResolvedValue({ blob: new Blob(["%PDF"], { type: "application/pdf" }), filename: "CAR-2026-0001.pdf" });

    const user = setup(loadDetail("planned", ["edit"]));
    await user.click(await screen.findByRole("button", { name: "Orden de carga (PDF)" }));

    await waitFor(() => expect(win.location.href).toBe("blob:pdf-1"));
    expect(mockedApi.blob).toHaveBeenCalledWith("/loads/l-1/loading-order.pdf");
  });

  it("con 503 PDF_UNAVAILABLE cierra la pestaña y avisa", async () => {
    const win = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    mockedApi.blob.mockRejectedValue(new ApiError({ status: 503, code: "PDF_UNAVAILABLE", message: "WeasyPrint no instalado" }));

    const user = setup(loadDetail("planned", ["edit"]));
    await user.click(await screen.findByRole("button", { name: "Orden de carga (PDF)" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("No se pueden generar PDF en este servidor ahora mismo."));
    expect(win.close).toHaveBeenCalled();
  });

  it("muestra el motivo de una carga cancelada y ninguna acción", async () => {
    setup(loadDetail("cancelled", [], { status_reason: "Avería del camión" }));
    expect(await screen.findByText("Avería del camión")).toBeInTheDocument();
    for (const name of ["Emitir a fábrica", "Cancelar carga", "Orden de carga (PDF)", "Devolver a planificación"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});
