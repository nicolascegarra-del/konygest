import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { tomorrow } from "@/components/orders/common";
import { formFieldFromApi, OrderForm } from "@/components/orders/order-form";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { formatKg, formatMoney, toIsoDate } from "@/lib/format";
import { useAuthStore } from "@/stores/auth-store";
import { renderWithQuery } from "@/test/query-wrapper";
import type { Me, Scope } from "@/types/api";
import type { MasterLookups } from "@/types/fase1";
import type { SalesOrderDetail } from "@/types/fase2";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }) }));

const mockedApi = vi.mocked(api);

const LOOKUPS: MasterLookups = {
  vat_rates: [],
  payment_methods: [],
  price_lists: [],
  carriers: [],
  sales_reps: [{ id: "rep-1", name: "Ana Comercial" }],
  silos: [],
  items: [
    { id: "mp-1", name: "Maíz", code: "MP01", kind: "raw_material" },
    { id: "p-1", name: "Cebo", code: "P-CEB", kind: "product" },
    { id: "p-2", name: "Lechones", code: "P-LEC", kind: "product" },
  ],
};

const CUSTOMERS = {
  items: [{ id: "c-1", code: "C01", name: "Granja Pérez", is_active: true }],
  total: 1,
  offset: 0,
  limit: 20,
};

const FARMS = {
  items: [
    {
      id: "f-1",
      customer_id: "c-1",
      name: "La Loma",
      city: "Lorca",
      silos: [
        { name: "Silo 1", capacity_kg: 20000 },
        { name: "Silo 2", capacity_kg: 15000 },
      ],
    },
  ],
  total: 1,
  offset: 0,
  limit: 200,
};

const QUOTES: Record<string, { price: number | null; source: string }> = {
  "p-1": { price: 0.315, source: "customer" },
  "p-2": { price: 0.29, source: "price_list" },
};

function me(scope: Scope): Me {
  return {
    id: "u-1",
    email: "ana@example.com",
    full_name: "Ana Comercial",
    tenant: { id: "t-1", name: "Piensos" },
    platform_role: null,
    permissions: { "pedidos.ver": scope, "pedidos.crear": scope },
    modules: ["ventas"],
    support_mode: false,
    read_only: false,
    totp_enabled: false,
    must_setup_2fa: false,
  };
}

function setup(options: { scope?: Scope; order?: SalesOrderDetail } = {}) {
  useAuthStore.setState({ user: me(options.scope ?? "own"), status: "authenticated" });
  renderWithQuery(<OrderForm order={options.order ?? null} />);
  return { user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;

async function chooseCustomer(user: User) {
  await screen.findByRole("option", { name: "C01 · Granja Pérez" });
  await user.selectOptions(screen.getByLabelText("Cliente *"), "c-1");
  // Una sola explotación: se elige sola.
  await waitFor(() => expect(screen.getByLabelText("Explotación *")).toHaveValue("f-1"));
}

async function fillLine(user: User, index: number, itemId: string, kg: string) {
  const n = index + 1;
  await screen.findAllByRole("option", { name: "P-CEB · Cebo" });
  await user.selectOptions(screen.getByLabelText(`Pienso de la línea ${n}`), itemId);
  await user.type(screen.getByLabelText(`Kilos de la línea ${n}`), kg);
}

describe("formulario de pedido", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.get.mockImplementation(async (path: string, query?: Record<string, unknown>) => {
      if (path === "/masters/lookups") return LOOKUPS;
      if (path === "/masters/customers") return CUSTOMERS;
      if (path === "/masters/farms") return FARMS;
      if (path === "/masters/customers/c-1/price") return QUOTES[String(query?.item_id)] ?? { price: null, source: "none" };
      throw new Error(`GET inesperado: ${path}`);
    });
    mockedApi.post.mockResolvedValue({ id: "o-1", number: "PED-2026-0001" });
    mockedApi.put.mockResolvedValue({ id: "o-1", number: "PED-2026-0001" });
  });

  it("propone mañana como fecha de entrega y solo ofrece piensos", async () => {
    setup();
    expect(screen.getByLabelText("Fecha de entrega *")).toHaveValue(toIsoDate(tomorrow()));
    await screen.findByRole("option", { name: "P-CEB · Cebo" });
    expect(screen.queryByRole("option", { name: "MP01 · Maíz" })).not.toBeInTheDocument();
  });

  it("prefija el precio del cliente con su origen y lo marca como manual al cambiarlo", async () => {
    const { user } = setup();
    await chooseCustomer(user);
    await fillLine(user, 0, "p-1", "12000");

    const price = screen.getByLabelText("Precio de la línea 1");
    await waitFor(() => expect(price).toHaveValue("0,315"));
    const source = screen.getByTestId("line-0-price-source");
    expect(source).toHaveTextContent("Negociado");
    expect(mockedApi.get).toHaveBeenCalledWith("/masters/customers/c-1/price", { item_id: "p-1" });

    await user.clear(price);
    await user.type(price, "0,30");
    expect(source).toHaveTextContent("Manual");
    expect(screen.getByText(/Por debajo del precio de referencia/)).toBeInTheDocument();

    // Volver al precio de referencia deja de ser manual.
    await user.clear(price);
    await user.type(price, "0,315");
    expect(source).toHaveTextContent("Negociado");
    expect(screen.queryByText(/Por debajo del precio de referencia/)).not.toBeInTheDocument();
  });

  it("ofrece los silos de la explotación elegida", async () => {
    const { user } = setup();
    await chooseCustomer(user);
    const silo = screen.getByLabelText("Silo de destino de la línea 1");
    expect(within(silo).getByRole("option", { name: "Silo 2" })).toBeInTheDocument();
  });

  it("calcula importes y totales en vivo", async () => {
    const { user } = setup();
    await chooseCustomer(user);
    await fillLine(user, 0, "p-1", "12.000");
    await waitFor(() => expect(screen.getByTestId("line-0-amount").textContent).toBe(formatMoney(3780)));

    await user.click(screen.getByRole("button", { name: "Añadir línea" }));
    await fillLine(user, 1, "p-2", "8000");
    await waitFor(() => expect(screen.getByTestId("line-1-amount").textContent).toBe(formatMoney(2320)));

    expect(screen.getByTestId("order-total-kg").textContent).toBe(formatKg(20000));
    expect(screen.getByTestId("order-total-amount").textContent).toBe(formatMoney(6100));
  });

  it("envía a validar con el cuerpo del contrato (sin comercial si es de alcance propio)", async () => {
    const { user } = setup();
    await chooseCustomer(user);
    expect(screen.queryByLabelText("Comercial")).not.toBeInTheDocument();
    await fillLine(user, 0, "p-1", "12.000");
    await waitFor(() => expect(screen.getByLabelText("Precio de la línea 1")).toHaveValue("0,315"));
    await user.selectOptions(screen.getByLabelText("Silo de destino de la línea 1"), "Silo 2");
    await user.click(screen.getByRole("button", { name: "Añadir línea" }));
    await fillLine(user, 1, "p-2", "5000");
    await waitFor(() => expect(screen.getByLabelText("Precio de la línea 2")).toHaveValue("0,29"));
    await user.clear(screen.getByLabelText("Precio de la línea 2"));
    await user.type(screen.getByLabelText("Precio de la línea 2"), "0,2850");
    await user.type(screen.getByLabelText("Notas"), "Llamar antes");

    await user.click(screen.getByRole("button", { name: "Enviar a validar" }));

    await waitFor(() =>
      expect(mockedApi.post).toHaveBeenCalledWith("/orders", {
        customer_id: "c-1",
        farm_id: "f-1",
        requested_date: toIsoDate(tomorrow()),
        notes: "Llamar antes",
        submit: true,
        lines: [
          { item_id: "p-1", quantity_kg: 12000, unit_price: 0.315, farm_silo: "Silo 2", notes: "" },
          { item_id: "p-2", quantity_kg: 5000, unit_price: 0.285, notes: "" },
        ],
      }),
    );
    expect(push).toHaveBeenCalledWith("/pedidos/o-1");
  });

  it("guarda borrador y, con alcance de oficina, envía el comercial elegido", async () => {
    const { user } = setup({ scope: "all" });
    await chooseCustomer(user);
    await screen.findByRole("option", { name: "Ana Comercial" });
    await user.selectOptions(screen.getByLabelText("Comercial"), "rep-1");
    await fillLine(user, 0, "p-1", "1000");
    await waitFor(() => expect(screen.getByLabelText("Precio de la línea 1")).toHaveValue("0,315"));

    await user.click(screen.getByRole("button", { name: "Guardar borrador" }));

    await waitFor(() => expect(mockedApi.post).toHaveBeenCalled());
    const body = mockedApi.post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.submit).toBe(false);
    expect(body.sales_rep_id).toBe("rep-1");
  });

  it("no envía con fecha pasada, líneas incompletas o repetidas", async () => {
    const { user } = setup();
    await chooseCustomer(user);
    fireEvent.change(screen.getByLabelText("Fecha de entrega *"), { target: { value: "2020-01-01" } });
    await user.click(screen.getByRole("button", { name: "Enviar a validar" }));

    expect(await screen.findByText("La fecha de entrega no puede ser anterior a hoy.")).toBeInTheDocument();
    expect(screen.getByText("Elige el pienso.")).toBeInTheDocument();
    expect(screen.getByText("Este campo es obligatorio.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Fecha de entrega *"), { target: { value: toIsoDate(tomorrow()) } });
    await fillLine(user, 0, "p-1", "1000");
    await user.click(screen.getByRole("button", { name: "Añadir línea" }));
    await fillLine(user, 1, "p-1", "2000");
    await user.click(screen.getByRole("button", { name: "Enviar a validar" }));

    expect(await screen.findByText("Este pienso ya está en otra línea sin silo.")).toBeInTheDocument();
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it("muestra en su campo el error de la API (lines.N.unit_price)", async () => {
    mockedApi.post.mockRejectedValueOnce(
      new ApiError({ status: 400, code: "PRICE_REQUIRED", message: "Sin precio", field: "lines.0.unit_price" }),
    );
    const { user } = setup();
    await chooseCustomer(user);
    await fillLine(user, 0, "p-1", "1000");
    await user.clear(screen.getByLabelText("Precio de la línea 1"));
    await user.click(screen.getByRole("button", { name: "Guardar borrador" }));

    const line = screen.getByTestId("order-line-0");
    expect(await within(line).findByText("El cliente no tiene precio para este pienso: indica el precio a mano.")).toBeInTheDocument();
    // Precio vacío: se envía `null` para que el backend aplique el del cliente.
    const body = mockedApi.post.mock.calls[0]?.[1] as { lines: { unit_price: unknown }[] };
    expect(body.lines[0]?.unit_price).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("traduce los campos de error de la API", () => {
    expect(formFieldFromApi("requested_date", 1)).toBe("requested_date");
    expect(formFieldFromApi("lines.2.unit_price", 3)).toBe("lines.2.unit_price");
    expect(formFieldFromApi("lines.1", 3)).toBe("lines.1.item_id");
    expect(formFieldFromApi("lines.5.unit_price", 3)).toBeNull();
    expect(formFieldFromApi("otro", 3)).toBeNull();
  });

  it("al editar, carga el pedido y hace PUT", async () => {
    const order: SalesOrderDetail = {
      id: "o-9",
      number: "PED-2026-0009",
      status: "rejected",
      customer_id: "c-1",
      customer_code: "C01",
      customer_name: "Granja Pérez",
      farm_id: "f-1",
      farm_name: "La Loma",
      sales_rep_id: "u-1",
      sales_rep_name: "Ana Comercial",
      requested_date: toIsoDate(tomorrow()),
      total_kg: 1000,
      total_amount: 300,
      line_count: 1,
      has_manual_price: true,
      created_at: "2026-11-01T10:00:00Z",
      submitted_at: "2026-11-01T10:05:00Z",
      updated_at: "2026-11-01T11:00:00Z",
      notes: "",
      status_reason: "Precio demasiado bajo",
      validated_by_name: null,
      validated_at: null,
      created_by_name: "Ana Comercial",
      allowed_actions: ["edit", "submit", "cancel"],
      lines: [
        {
          id: "l-1",
          position: 0,
          item_id: "p-1",
          item_code: "P-CEB",
          item_name: "Cebo",
          quantity_kg: 1000,
          unit_price: 0.3,
          price_source: "manual",
          reference_price: 0.315,
          amount: 300,
          farm_silo: "Silo 1",
          notes: "",
        },
      ],
    };
    const { user } = setup({ order });
    expect(screen.getByLabelText("Precio de la línea 1")).toHaveValue("0,3");
    expect(screen.getByTestId("line-0-price-source")).toHaveTextContent("Manual");
    await screen.findByRole("option", { name: "La Loma · Lorca" });

    await user.click(screen.getByRole("button", { name: "Enviar a validar" }));
    await waitFor(() =>
      expect(mockedApi.put).toHaveBeenCalledWith(
        "/orders/o-9",
        expect.objectContaining({
          submit: true,
          lines: [{ item_id: "p-1", quantity_kg: 1000, unit_price: 0.3, farm_silo: "Silo 1", notes: "" }],
        }),
      ),
    );
  });
});
