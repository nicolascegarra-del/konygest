import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MASTER_DEFINITIONS, VAT_RATE_FIELDS } from "@/components/masters/definitions";
import { MasterDialog, type MasterFormConfig } from "@/components/masters/master-dialog";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { renderWithQuery } from "@/test/query-wrapper";
import type { MasterLookups } from "@/types/fase1";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockedApi = vi.mocked(api);

const LOOKUPS: MasterLookups = {
  vat_rates: [],
  payment_methods: [],
  price_lists: [],
  carriers: [{ id: "car-1", name: "Transportes Segura" }],
  sales_reps: [],
  silos: [],
  items: [],
};

const VAT_CONFIG: MasterFormConfig = {
  resource: "vat-rates",
  fields: VAT_RATE_FIELDS,
  newLabel: "Nuevo tipo de IVA",
  editLabel: "Editar tipo de IVA",
  savedMessage: "Guardado.",
};

function setup(config: MasterFormConfig, record: ({ id: string } & Record<string, unknown>) | null = null) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  renderWithQuery(<MasterDialog config={config} record={record} onSaved={onSaved} onClose={onClose} />);
  return { onSaved, onClose, user: userEvent.setup() };
}

describe("formulario genérico de maestro", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.get.mockResolvedValue(LOOKUPS);
    mockedApi.post.mockResolvedValue({ id: "nuevo" });
    mockedApi.put.mockResolvedValue({ id: "vat-1" });
  });

  it("no envía nada y marca los obligatorios si faltan", async () => {
    const { user } = setup(VAT_CONFIG);

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findAllByText("Este campo es obligatorio.")).toHaveLength(2);
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it("valida los números (formato, rango y decimales)", async () => {
    const { user } = setup(VAT_CONFIG);

    await user.type(screen.getByLabelText("Nombre *"), "General");
    await user.type(screen.getByLabelText("Tipo de IVA *"), "abc");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Introduce un número válido.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Tipo de IVA *"));
    await user.type(screen.getByLabelText("Tipo de IVA *"), "150");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Debe ser como máximo 100.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Tipo de IVA *"));
    await user.type(screen.getByLabelText("Tipo de IVA *"), "21,123");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Como máximo 2 decimales.")).toBeInTheDocument();
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it("da de alta con POST y convierte los números con coma", async () => {
    const { user, onSaved } = setup(VAT_CONFIG);

    await user.type(screen.getByLabelText("Nombre *"), "  General  ");
    await user.type(screen.getByLabelText("Tipo de IVA *"), "21");
    const surcharge = screen.getByLabelText("Recargo de equivalencia *");
    expect(surcharge).toHaveValue("0");
    await user.clear(surcharge);
    await user.type(surcharge, "5,2");
    await user.click(screen.getByRole("switch", { name: /Predeterminado/ }));
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() =>
      expect(mockedApi.post).toHaveBeenCalledWith("/masters/vat-rates", {
        name: "General",
        rate: 21,
        surcharge: 5.2,
        is_default: true,
        is_active: true,
      }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("edita con PUT enviando la ficha completa y permite dar de baja", async () => {
    const { user } = setup(VAT_CONFIG, {
      id: "vat-1",
      name: "Reducido",
      rate: 10,
      surcharge: 1.4,
      is_default: false,
      is_active: true,
      created_at: "2026-01-01T00:00:00Z",
    });

    expect(screen.getByLabelText("Recargo de equivalencia *")).toHaveValue("1,4");
    await user.click(screen.getByRole("switch", { name: /Activo/ }));
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() =>
      expect(mockedApi.put).toHaveBeenCalledWith("/masters/vat-rates/vat-1", {
        name: "Reducido",
        rate: 10,
        surcharge: 1.4,
        is_default: false,
        is_active: false,
      }),
    );
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it("camión: compartimentos como lista, capacidad total, matrícula en mayúsculas y nulos", async () => {
    const { user } = setup(MASTER_DEFINITIONS.trucks);

    await user.type(screen.getByLabelText("Matrícula *"), "1234 abc");
    await user.type(screen.getByLabelText("Compartimento 1 (kg)"), "8.000");
    await user.click(screen.getByRole("button", { name: /Añadir compartimento/ }));
    await user.type(screen.getByLabelText("Compartimento 2 (kg)"), "6000,5");
    expect(screen.getByText(/Capacidad total/)).toHaveTextContent("14.000,50");

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() =>
      expect(mockedApi.post).toHaveBeenCalledWith("/masters/trucks", {
        plate: "1234 ABC",
        carrier_id: null,
        compartments: [8000, 6000.5],
        notes: "",
        is_active: true,
      }),
    );
  });

  it("camión: exige al menos un compartimento válido", async () => {
    const { user } = setup(MASTER_DEFINITIONS.trucks);

    await user.type(screen.getByLabelText("Matrícula *"), "1234ABC");
    await user.type(screen.getByLabelText("Compartimento 1 (kg)"), "0");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Compartimento 1: debe ser mayor que 0.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quitar compartimento 1" }));
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Añade al menos un compartimento.")).toBeInTheDocument();
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it("marca en el campo el conflicto que devuelve el servidor", async () => {
    mockedApi.post.mockRejectedValueOnce(
      new ApiError({ status: 409, code: "CONFLICT", message: "Ya existe un tipo de IVA con ese nombre.", field: "name" }),
    );
    const { user, onSaved } = setup(VAT_CONFIG);

    await user.type(screen.getByLabelText("Nombre *"), "General");
    await user.type(screen.getByLabelText("Tipo de IVA *"), "21");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByText("Ya existe un tipo de IVA con ese nombre.")).toBeInTheDocument();
    expect(screen.getByLabelText("Nombre *")).toHaveAttribute("aria-invalid", "true");
    expect(onSaved).not.toHaveBeenCalled();
  });
});
