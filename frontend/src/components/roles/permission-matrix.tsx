"use client";

import { Select } from "@/components/ui/input";
import type { PermissionDef, Scope } from "@/types/api";

interface PermissionMatrixProps {
  permissions: PermissionDef[];
  value: Record<string, Scope>;
  onChange: (next: Record<string, Scope>) => void;
  disabled?: boolean;
}

/** Agrupa los permisos por área manteniendo el orden en que llegan del catálogo. */
export function groupByArea(permissions: PermissionDef[]): Array<{ area: string; items: PermissionDef[] }> {
  const groups = new Map<string, PermissionDef[]>();
  for (const permission of permissions) {
    const list = groups.get(permission.area) ?? [];
    list.push(permission);
    groups.set(permission.area, list);
  }
  return Array.from(groups, ([area, items]) => ({ area, items }));
}

/**
 * Matriz de permisos de un rol, agrupada por área. Los permisos con alcance (`scoped`) permiten
 * elegir «Solo los propios» o «Todos»; los de módulos inactivos están deshabilitados.
 */
export function PermissionMatrix({ permissions, value, onChange, disabled = false }: PermissionMatrixProps) {
  function setGranted(permission: PermissionDef, granted: boolean): void {
    const next = { ...value };
    if (granted) next[permission.code] = permission.scoped ? "own" : "all";
    else delete next[permission.code];
    onChange(next);
  }

  function setScope(code: string, scope: Scope): void {
    onChange({ ...value, [code]: scope });
  }

  function setArea(items: PermissionDef[], granted: boolean): void {
    const next = { ...value };
    for (const permission of items) {
      if (!permission.available) continue;
      if (granted) next[permission.code] = next[permission.code] ?? (permission.scoped ? "own" : "all");
      else delete next[permission.code];
    }
    onChange(next);
  }

  return (
    <div className="space-y-4">
      {groupByArea(permissions).map(({ area, items }) => {
        const selectable = items.filter((permission) => permission.available);
        const allGranted = selectable.length > 0 && selectable.every((permission) => permission.code in value);
        return (
          <fieldset key={area} className="rounded-lg border">
            <legend className="sr-only">{area}</legend>
            <div className="flex items-center justify-between gap-2 border-b bg-muted px-4 py-2">
              <h3 className="text-sm font-semibold">{area}</h3>
              <button
                type="button"
                disabled={disabled || selectable.length === 0}
                onClick={() => setArea(items, !allGranted)}
                className="min-h-11 px-2 text-sm text-link hover:underline disabled:opacity-50 md:min-h-8"
              >
                {allGranted ? "Quitar todos" : "Conceder todos"}
              </button>
            </div>
            <ul className="divide-y">
              {items.map((permission) => {
                const granted = permission.code in value;
                const id = `perm-${permission.code}`;
                const locked = disabled || !permission.available;
                return (
                  <li key={permission.code} className="flex flex-col gap-2 px-4 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <input
                        id={id}
                        type="checkbox"
                        className="mt-3 size-5 shrink-0 accent-[#2E6DB4] sm:mt-0.5"
                        checked={granted}
                        disabled={locked}
                        onChange={(event) => setGranted(permission, event.target.checked)}
                      />
                      <label htmlFor={id} className="flex min-h-11 flex-col justify-center text-sm">
                        <span className={permission.available ? "" : "text-muted-foreground"}>{permission.name}</span>
                        {!permission.available ? (
                          <span className="text-xs text-muted-foreground">Requiere activar el módulo en la empresa</span>
                        ) : null}
                      </label>
                    </div>
                    {permission.scoped && granted ? (
                      <Select
                        aria-label={`Alcance de ${permission.name}`}
                        value={value[permission.code]}
                        disabled={locked}
                        onChange={(event) => setScope(permission.code, event.target.value as Scope)}
                        className="sm:w-44"
                      >
                        <option value="own">Solo los propios</option>
                        <option value="all">Todos</option>
                      </Select>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}
