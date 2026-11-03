"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { CreateTenantDialog } from "@/components/admin/create-tenant-dialog";
import { DataList, type DataColumn } from "@/components/common/data-list";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { TENANT_STATUS_LABELS, TENANT_STATUS_VARIANTS, TENANT_STATUSES } from "@/lib/labels";
import type { AdminTenantRow, Page, TenantStatus } from "@/types/api";

const PAGE_SIZE = 25;

const columns: DataColumn<AdminTenantRow>[] = [
  {
    key: "name",
    header: "Empresa",
    render: (tenant) => (
      <Link href={`/admin/empresas/${tenant.id}`} className="font-medium text-link hover:underline">
        {tenant.name}
      </Link>
    ),
  },
  {
    key: "status",
    header: "Estado",
    render: (tenant) => <Badge variant={TENANT_STATUS_VARIANTS[tenant.status]}>{TENANT_STATUS_LABELS[tenant.status]}</Badge>,
  },
  { key: "plan", header: "Plan", render: (tenant) => tenant.plan_code ?? "—" },
  { key: "users", header: "Usuarios", render: (tenant) => tenant.users },
  { key: "activity", header: "Última actividad", render: (tenant) => formatDate(tenant.last_activity_at) },
  { key: "created", header: "Alta", render: (tenant) => formatDate(tenant.created_at) },
];

export function TenantsPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<TenantStatus | "">("");
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const debouncedSearch = useDebouncedValue(search.trim());

  const query = useQuery({
    queryKey: ["admin", "tenants", debouncedSearch, status, offset],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<Page<AdminTenantRow>>(
        "/admin/tenants",
        { search: debouncedSearch, status, offset, limit: PAGE_SIZE },
        signal,
      ),
  });

  return (
    <>
      <PageHeader
        title="Empresas"
        description="Las fábricas que usan Konygest."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden /> Nueva empresa
          </Button>
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative max-w-md flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
            placeholder="Buscar por nombre o CIF"
            aria-label="Buscar empresas"
            className="pl-9"
          />
        </div>
        <Select
          aria-label="Filtrar por estado"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as TenantStatus | "");
            setOffset(0);
          }}
          className="sm:w-48"
        >
          <option value="">Todos los estados</option>
          {TENANT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {TENANT_STATUS_LABELS[value]}
            </option>
          ))}
        </Select>
      </div>

      {query.isPending ? (
        <LoadingBlock rows={5} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          title={debouncedSearch || status ? "Ninguna empresa coincide con el filtro" : "Aún no hay empresas"}
          description={debouncedSearch || status ? undefined : "Da de alta la primera con «Nueva empresa»."}
        />
      ) : (
        <>
          <DataList rows={query.data.items} columns={columns} rowKey={(tenant) => tenant.id} />
          <Pagination offset={offset} limit={PAGE_SIZE} total={query.data.total} onChange={setOffset} />
        </>
      )}

      {creating ? <CreateTenantDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
