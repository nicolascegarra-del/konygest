import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { groupByArea, PermissionMatrix } from "@/components/roles/permission-matrix";
import type { PermissionDef, Scope } from "@/types/api";

const permissions: PermissionDef[] = [
  { code: "usuarios.ver", area: "Usuarios", name: "Ver usuarios", module: "core", scoped: false, available: true },
  { code: "usuarios.gestionar", area: "Usuarios", name: "Invitar y editar usuarios", module: "core", scoped: false, available: true },
  { code: "pedidos.ver", area: "Pedidos", name: "Ver pedidos", module: "ventas", scoped: true, available: true },
  { code: "crm.ver", area: "CRM", name: "Ver visitas", module: "crm", scoped: true, available: false },
];

function setup(value: Record<string, Scope> = {}, disabled = false) {
  const onChange = vi.fn<(next: Record<string, Scope>) => void>();
  render(<PermissionMatrix permissions={permissions} value={value} onChange={onChange} disabled={disabled} />);
  return { onChange, user: userEvent.setup() };
}

describe("matriz de permisos", () => {
  it("agrupa los permisos por área manteniendo el orden", () => {
    expect(groupByArea(permissions).map((group) => group.area)).toEqual(["Usuarios", "Pedidos", "CRM"]);

    setup();
    expect(screen.getByRole("heading", { name: "Usuarios" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pedidos" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "CRM" })).toBeInTheDocument();
  });

  it("conceder un permiso sin alcance lo marca como «all»", async () => {
    const { onChange, user } = setup();

    await user.click(screen.getByLabelText("Ver usuarios"));

    expect(onChange).toHaveBeenCalledWith({ "usuarios.ver": "all" });
  });

  it("conceder un permiso con alcance empieza por «propios»", async () => {
    const { onChange, user } = setup();

    await user.click(screen.getByLabelText("Ver pedidos"));

    expect(onChange).toHaveBeenCalledWith({ "pedidos.ver": "own" });
  });

  it("solo muestra el selector de alcance en permisos con alcance concedidos y permite cambiarlo", async () => {
    const { onChange, user } = setup({ "pedidos.ver": "own", "usuarios.ver": "all" });

    expect(screen.queryByLabelText("Alcance de Ver usuarios")).not.toBeInTheDocument();
    const selector = screen.getByLabelText("Alcance de Ver pedidos");
    expect(selector).toHaveValue("own");

    await user.selectOptions(selector, "all");

    expect(onChange).toHaveBeenCalledWith({ "pedidos.ver": "all", "usuarios.ver": "all" });
  });

  it("retirar un permiso lo elimina del objeto", async () => {
    const { onChange, user } = setup({ "usuarios.ver": "all", "usuarios.gestionar": "all" });

    await user.click(screen.getByLabelText("Invitar y editar usuarios"));

    expect(onChange).toHaveBeenCalledWith({ "usuarios.ver": "all" });
  });

  it("los permisos de módulos inactivos están deshabilitados y avisan", () => {
    setup();

    expect(screen.getByLabelText(/Ver visitas/)).toBeDisabled();
    expect(screen.getByText("Requiere activar el módulo en la empresa")).toBeInTheDocument();
  });

  it("«Conceder todos» concede los disponibles del área y salta los de módulos inactivos", async () => {
    const { onChange, user } = setup();
    const buttons = screen.getAllByRole("button", { name: "Conceder todos" });

    await user.click(buttons[0] as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith({ "usuarios.ver": "all", "usuarios.gestionar": "all" });

    // El área CRM no tiene nada disponible: el botón está deshabilitado.
    expect(buttons[2]).toBeDisabled();
  });

  it("«Quitar todos» aparece cuando todos los disponibles del área están concedidos", async () => {
    const { onChange, user } = setup({ "usuarios.ver": "all", "usuarios.gestionar": "all", "pedidos.ver": "own" });

    await user.click(screen.getAllByRole("button", { name: "Quitar todos" })[0] as HTMLElement);

    expect(onChange).toHaveBeenCalledWith({ "pedidos.ver": "own" });
  });

  it("en modo solo lectura no deja cambiar nada", () => {
    setup({ "usuarios.ver": "all" }, true);

    expect(screen.getByLabelText("Ver usuarios")).toBeDisabled();
    expect(screen.getAllByRole("button", { name: /todos/ })[0]).toBeDisabled();
  });
});
