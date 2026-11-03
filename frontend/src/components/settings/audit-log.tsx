"use client";

import { useQuery } from "@tanstack/react-query";
import { keepPreviousData } from "@tanstack/react-query";
import { useState } from "react";

import { DataList, type DataColumn } from "@/components/common/data-list";
import { EmptyState, ErrorState, LoadingBlock, Pagination } from "@/components/common/states";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { AuditEntry, Page } from "@/types/api";

const PAGE_SIZE = 25;

const columns: DataColumn<AuditEntry>[] = [
  { key: "date", header: "Fecha", render: (row) => formatDateTime(row.created_at) },
  { key: "action", header: "Acción", render: (row) => <code className="text-xs">{row.action}</code> },
  { key: "user", header: "Usuario", render: (row) => row.user_email ?? "Sistema" },
  {
    key: "entity",
    header: "Elemento",
    render: (row) => (row.entity ? `${row.entity}${row.entity_id ? ` · ${row.entity_id.slice(0, 8)}` : ""}` : "—"),
  },
  {
    key: "data",
    header: "Detalle",
    render: (row) =>
      row.data && Object.keys(row.data).length > 0 ? (
        <details>
          <summary className="cursor-pointer text-link">Ver</summary>
          <pre className="mt-1 max-w-xs overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-left text-xs">
            {JSON.stringify(row.data, null, 2)}
          </pre>
        </details>
      ) : (
        "—"
      ),
  },
];

export function AuditLog() {
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ["audit", offset],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => api.get<Page<AuditEntry>>("/audit", { offset, limit: PAGE_SIZE }, signal),
  });

  if (query.isPending) return <LoadingBlock rows={6} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (query.data.items.length === 0) {
    return <EmptyState title="Aún no hay actividad registrada" />;
  }
  return (
    <>
      <DataList rows={query.data.items} columns={columns} rowKey={(row) => row.id} />
      <Pagination offset={offset} limit={PAGE_SIZE} total={query.data.total} onChange={setOffset} />
    </>
  );
}
