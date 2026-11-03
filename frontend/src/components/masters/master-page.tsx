"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Pencil, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { DataList, type DataColumn } from "@/components/common/data-list";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { optionLabel, useMasterLookups } from "@/hooks/use-master-lookups";
import { api } from "@/lib/api";
import { can } from "@/lib/auth";
import { useAuthStore } from "@/stores/auth-store";
import type { Page } from "@/types/api";
import type { MasterRecord } from "@/types/fase1";

import { MASTER_DEFINITIONS, type MasterKey } from "./definitions";
import { MasterDialog } from "./master-dialog";
import type { AnyMasterDefinition, MasterFilter } from "./types";

const PAGE_SIZE = 25;

type ActiveFilter = "true" | "false" | "";

/** Columna de estado común a todos los maestros. */
export function activeBadge(active: boolean) {
  return active ? <Badge variant="success">Activo</Badge> : <Badge variant="destructive">De baja</Badge>;
}

/** Hay que poder escribir en maestros: permiso y cuenta que no esté en solo lectura. */
export function useCanManageMasters(): boolean {
  const me = useAuthStore((state) => state.user);
  return can(me, "maestros.gestionar") && !me?.read_only;
}

/** Página de listado de un maestro a partir de su definición (ver `definitions.tsx`). */
export function MasterPage({ resource }: { resource: MasterKey }) {
  return <MasterListView definition={MASTER_DEFINITIONS[resource]} />;
}

function FilterSelect({
  filter,
  value,
  onChange,
}: {
  filter: MasterFilter;
  value: string;
  onChange: (value: string) => void;
}) {
  const lookups = useMasterLookups(!!filter.lookup);
  const options = filter.options
    ? filter.options
    : (filter.lookup ? (lookups.data?.[filter.lookup] ?? []) : []).map((option) => ({
        value: option.id,
        label: optionLabel(option),
      }));
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)} aria-label={filter.label} className="sm:w-56">
      <option value="">{filter.allLabel}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}

export function MasterListView({ definition }: { definition: AnyMasterDefinition }) {
  const queryClient = useQueryClient();
  const canManage = useCanManageMasters();

  const [search, setSearch] = useState("");
  const [active, setActive] = useState<ActiveFilter>("true");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<MasterRecord | "new" | null>(null);
  const debouncedSearch = useDebouncedValue(search.trim());

  const list = useQuery({
    queryKey: ["masters", definition.resource, "list", { search: debouncedSearch, active, filters, offset }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<Page<MasterRecord>>(
        `/masters/${definition.resource}`,
        { search: debouncedSearch, active, ...filters, offset, limit: PAGE_SIZE },
        signal,
      ),
  });

  const filtered = !!debouncedSearch || active !== "true" || Object.values(filters).some(Boolean);

  const columns: DataColumn<MasterRecord>[] = [
    ...definition.columns,
    { key: "is_active", header: "Estado", render: (row) => activeBadge(row.is_active) },
    ...(canManage || definition.detailHref
      ? [
          {
            key: "actions",
            header: "Acciones",
            isActions: true,
            render: (row: MasterRecord) => (
              <div className="flex flex-wrap gap-2">
                {definition.detailHref ? (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={definition.detailHref(row)}>
                      <Eye aria-hidden /> Ver ficha
                    </Link>
                  </Button>
                ) : null}
                {canManage ? (
                  <Button variant="outline" size="sm" onClick={() => setEditing(row)}>
                    <Pencil aria-hidden /> Editar
                  </Button>
                ) : null}
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={definition.title}
        description={definition.description}
        actions={
          canManage ? (
            <Button onClick={() => setEditing("new")}>
              <Plus aria-hidden /> {definition.newLabel}
            </Button>
          ) : undefined
        }
      />
      {definition.intro}

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative w-full sm:max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
            placeholder={definition.searchPlaceholder}
            aria-label={`Buscar en ${definition.title.toLowerCase()}`}
            className="pl-9"
          />
        </div>
        {definition.filters?.map((filter) => (
          <FilterSelect
            key={filter.name}
            filter={filter}
            value={filters[filter.name] ?? ""}
            onChange={(value) => {
              setFilters((current) => ({ ...current, [filter.name]: value }));
              setOffset(0);
            }}
          />
        ))}
        <Select
          value={active}
          onChange={(event) => {
            setActive(event.target.value as ActiveFilter);
            setOffset(0);
          }}
          aria-label="Estado"
          className="sm:w-44"
        >
          <option value="true">Solo activos</option>
          <option value="false">Solo de baja</option>
          <option value="">Todos</option>
        </Select>
      </div>

      {list.isPending ? (
        <LoadingBlock rows={5} />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? "Nada coincide con los filtros" : definition.emptyTitle}
          description={filtered ? "Prueba con otra búsqueda o cambia los filtros." : definition.emptyDescription}
          action={
            !filtered && canManage ? (
              <Button onClick={() => setEditing("new")}>
                <Plus aria-hidden /> {definition.newLabel}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <DataList rows={list.data.items} columns={columns} rowKey={(row) => row.id} />
          <Pagination offset={offset} limit={PAGE_SIZE} total={list.data.total} onChange={setOffset} />
        </>
      )}

      {editing !== null ? (
        <MasterDialog
          config={definition}
          record={editing === "new" ? null : (editing as MasterRecord & Record<string, unknown>)}
          description={editing !== "new" && definition.describe ? definition.describe(editing) : undefined}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void queryClient.invalidateQueries({ queryKey: ["masters"] });
          }}
        />
      ) : null}
    </>
  );
}
