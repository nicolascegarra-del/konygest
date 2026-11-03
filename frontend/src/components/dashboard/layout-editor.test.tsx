import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LayoutEditor } from "@/components/dashboard/layout-editor";
import type { WidgetCatalogEntry, WidgetItem } from "@/types/api";

const catalog: WidgetCatalogEntry[] = [
  { code: "bienvenida", name: "Bienvenida", description: "Saludo" },
  { code: "accesos_rapidos", name: "Accesos rápidos", description: "Atajos" },
  { code: "notificaciones", name: "Últimos avisos", description: "Avisos" },
  { code: "resumen_empresa", name: "Resumen de la empresa", description: "Cifras" },
];

const layout: WidgetItem[] = [
  { widget: "bienvenida", size: "lg" },
  { widget: "accesos_rapidos", size: "md" },
];

function setup(initial: WidgetItem[] = layout) {
  const onChange = vi.fn<(next: WidgetItem[]) => void>();
  render(<LayoutEditor layout={initial} catalog={catalog} onChange={onChange} />);
  return { onChange, user: userEvent.setup() };
}

describe("editor de la pantalla inicial", () => {
  it("lista los widgets en pantalla y solo ofrece del catálogo los que faltan", () => {
    setup();

    expect(screen.getByTestId("layout-row-bienvenida")).toBeInTheDocument();
    expect(screen.getByTestId("layout-row-accesos_rapidos")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Añadir Últimos avisos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Añadir Resumen de la empresa" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Añadir Bienvenida" })).not.toBeInTheDocument();
  });

  it("añadir un widget del catálogo lo agrega al final con tamaño mediano", async () => {
    const { onChange, user } = setup();

    await user.click(screen.getByRole("button", { name: "Añadir Últimos avisos" }));

    expect(onChange).toHaveBeenCalledWith([...layout, { widget: "notificaciones", size: "md" }]);
  });

  it("quitar un widget lo elimina de la lista", async () => {
    const { onChange, user } = setup();

    await user.click(screen.getByRole("button", { name: "Quitar Bienvenida" }));

    expect(onChange).toHaveBeenCalledWith([{ widget: "accesos_rapidos", size: "md" }]);
  });

  it("cambiar el tamaño actualiza solo ese widget", async () => {
    const { onChange, user } = setup();

    await user.selectOptions(screen.getByLabelText("Tamaño de Accesos rápidos"), "sm");

    expect(onChange).toHaveBeenCalledWith([
      { widget: "bienvenida", size: "lg" },
      { widget: "accesos_rapidos", size: "sm" },
    ]);
  });

  it("bajar y subir reordenan los widgets, y los extremos están deshabilitados", async () => {
    const { onChange, user } = setup();

    expect(screen.getByRole("button", { name: "Subir Bienvenida" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bajar Accesos rápidos" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Bajar Bienvenida" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { widget: "accesos_rapidos", size: "md" },
      { widget: "bienvenida", size: "lg" },
    ]);

    await user.click(screen.getByRole("button", { name: "Subir Accesos rápidos" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { widget: "accesos_rapidos", size: "md" },
      { widget: "bienvenida", size: "lg" },
    ]);
  });

  it("con la pantalla vacía muestra el aviso y todo el catálogo", () => {
    setup([]);

    expect(screen.getByText("No hay widgets. Añade alguno del catálogo.")).toBeInTheDocument();
    const catalogSection = screen.getByRole("heading", { name: "Catálogo" }).closest("section");
    expect(catalogSection).not.toBeNull();
    if (catalogSection) expect(within(catalogSection).getAllByRole("button")).toHaveLength(catalog.length);
  });

  it("un widget desconocido para el catálogo se muestra por su código", () => {
    setup([{ widget: "stock_por_silo", size: "sm" }]);

    expect(screen.getByText("stock_por_silo")).toBeInTheDocument();
  });
});
