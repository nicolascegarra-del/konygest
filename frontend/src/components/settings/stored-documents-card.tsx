"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";

import { DataList, type DataColumn } from "@/components/common/data-list";
import { EmptyState, ErrorState, LoadingBlock, Pagination } from "@/components/common/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { DOCUMENT_KIND_LABELS, documentKindLabel, STORAGE_PROVIDER_LABELS } from "@/lib/labels";
import type { Page } from "@/types/api";
import type { DocumentKind, StoredDocument } from "@/types/documents";

import { ENDPOINT, STORAGE_KEY } from "./storage-common";

const DOCUMENTS_PAGE_SIZE = 25;

// ─── Documentos guardados ──────────────────────────

const documentColumns: DataColumn<StoredDocument>[] = [
  { key: "number", header: "Número", render: (row) => <span className="font-medium">{row.number}</span> },
  { key: "kind", header: "Tipo", render: (row) => documentKindLabel(row.kind) },
  {
    key: "provider",
    header: "Guardado en",
    render: (row) => STORAGE_PROVIDER_LABELS[row.provider] ?? row.provider,
  },
  { key: "size", header: "Tamaño", render: (row) => formatBytes(row.size) },
  { key: "date", header: "Fecha", render: (row) => formatDateTime(row.created_at) },
];

/** Listado paginado de los documentos guardados, con el destino donde quedó cada uno. */
export function StoredDocumentsCard() {
  const [kind, setKind] = useState<DocumentKind | "">("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const debouncedSearch = useDebouncedValue(search.trim());
  const filtered = kind !== "" || debouncedSearch !== "";

  const query = useQuery({
    queryKey: [...STORAGE_KEY, "documents", { kind, search: debouncedSearch, offset }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<Page<StoredDocument>>(
        `${ENDPOINT}/documents`,
        { kind, search: debouncedSearch, offset, limit: DOCUMENTS_PAGE_SIZE },
        signal,
      ),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Documentos guardados</CardTitle>
        <CardDescription>Cada documento indica dónde se guardó. Si falta en su destino, se vuelve a generar al abrirlo.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
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
              placeholder="Buscar por número"
              aria-label="Buscar documentos por número"
              className="pl-9"
            />
          </div>
          <Select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as DocumentKind | "");
              setOffset(0);
            }}
            aria-label="Tipo de documento"
            className="sm:w-56"
          >
            <option value="">Todos los tipos</option>
            {(Object.keys(DOCUMENT_KIND_LABELS) as DocumentKind[]).map((value) => (
              <option key={value} value={value}>
                {DOCUMENT_KIND_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>

        {query.isPending ? (
          <LoadingBlock rows={4} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : query.data.items.length === 0 ? (
          <EmptyState
            title={filtered ? "No hay documentos con esos filtros" : "Aún no se ha guardado ningún documento"}
            description={filtered ? undefined : "Aquí aparecerán los albaranes y las órdenes de carga en cuanto se generen."}
          />
        ) : (
          <>
            <DataList rows={query.data.items} columns={documentColumns} rowKey={(row) => row.id} />
            <Pagination offset={offset} limit={DOCUMENTS_PAGE_SIZE} total={query.data.total} onChange={setOffset} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
