"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { DataList, type DataColumn } from "@/components/common/data-list";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatDateTime, formatPlainDate } from "@/lib/format";
import { VERIFACTU_RECORD_TYPE_LABELS, verifactuSendStatusLabel } from "@/lib/labels";
import type { Page } from "@/types/api";
import type { VerifactuRecord, VerifactuVerifyResult } from "@/types/fase4";

import { CopyButton, invoiceHref, Money, shortHash } from "./common";

const PAGE_SIZE = 25;

const COLUMNS: DataColumn<VerifactuRecord>[] = [
  {
    key: "sequence",
    header: "Registro",
    render: (row) => (
      <span className="inline-flex flex-col">
        <span className="font-medium tabular-nums">Nº {row.sequence}</span>
        <span className="text-xs text-muted-foreground">{formatDateTime(row.generated_at)}</span>
      </span>
    ),
  },
  {
    key: "type",
    header: "Tipo",
    render: (row) => (
      <Badge variant={row.record_type === "anulacion" ? "destructive" : "secondary"}>
        {VERIFACTU_RECORD_TYPE_LABELS[row.record_type] ?? row.record_type}
        {row.invoice_type ? ` · ${row.invoice_type}` : ""}
      </Badge>
    ),
  },
  {
    key: "invoice",
    header: "Factura",
    render: (row) => (
      <Link href={invoiceHref(row.invoice_id)} className="inline-flex min-h-11 items-center text-link hover:underline md:min-h-0">
        {row.invoice_number}
      </Link>
    ),
  },
  { key: "date", header: "Fecha", render: (row) => formatPlainDate(row.issue_date) },
  { key: "total", header: "Total", render: (row) => (row.total_amount === null ? "—" : <Money value={row.total_amount} />) },
  {
    key: "hash",
    header: "Huella",
    render: (row) => (
      <span className="inline-flex items-center gap-1">
        <code className="font-mono text-xs" title={row.hash}>
          {shortHash(row.hash)}
        </code>
        <CopyButton value={row.hash} label={`Copiar la huella del registro ${row.sequence}`} />
      </span>
    ),
  },
  {
    key: "send",
    header: "Envío",
    render: (row) => <span className="text-xs text-muted-foreground">{verifactuSendStatusLabel(row.send_status)}</span>,
  },
];

/** Comprobación de la cadena de huellas: se pide al pulsar el botón (recalcula todos los registros). */
function ChainCheck() {
  const [requested, setRequested] = useState(false);
  const verify = useQuery({
    queryKey: ["verifactu", "verify"],
    enabled: requested,
    queryFn: ({ signal }) => api.get<VerifactuVerifyResult>("/verifactu/verify", undefined, signal),
  });

  const run = () => {
    if (requested) void verify.refetch();
    else setRequested(true);
  };

  return (
    <Card className="mb-5">
      <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 text-sm" aria-live="polite">
          {!requested ? (
            <p className="text-muted-foreground">
              Recalcula todas las huellas y comprueba que cada registro enlaza con el anterior.
            </p>
          ) : verify.isFetching && !verify.data ? (
            <p className="text-muted-foreground">Comprobando la cadena…</p>
          ) : verify.isError ? (
            <ErrorState error={verify.error} onRetry={() => verify.refetch()} />
          ) : verify.data?.ok ? (
            <p className="flex items-center gap-2 font-medium text-success" role="status">
              <ShieldCheck className="size-5 shrink-0" aria-hidden />
              Cadena correcta: {verify.data.records} {verify.data.records === 1 ? "registro comprobado" : "registros comprobados"}.
            </p>
          ) : verify.data ? (
            <div role="alert" className="text-destructive">
              <p className="flex items-center gap-2 font-medium">
                <ShieldAlert className="size-5 shrink-0" aria-hidden />
                Cadena rota: {verify.data.broken.length} de {verify.data.records}{" "}
                {verify.data.records === 1 ? "registro no cuadra" : "registros no cuadran"}.
              </p>
              <ul className="mt-2 list-disc pl-6 text-foreground">
                {verify.data.broken.map((item) => (
                  <li key={item.sequence}>
                    Registro nº {item.sequence} — {item.invoice_number}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-muted-foreground">Contacta con Klyp: el registro no debe modificarse a mano.</p>
            </div>
          ) : null}
        </div>
        <Button variant="outline" className="shrink-0" loading={verify.isFetching} onClick={run}>
          <ShieldCheck aria-hidden /> Comprobar la cadena
        </Button>
      </CardContent>
    </Card>
  );
}

/** Registro Verifactu de la empresa: comprobación de la cadena y listado de altas y anulaciones. */
export function VerifactuPage() {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [offset, setOffset] = useState(0);
  const params = { date_from: dateFrom, date_to: dateTo };
  const query = useQuery({
    queryKey: ["verifactu", "records", { ...params, offset }],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => api.get<Page<VerifactuRecord>>("/verifactu/records", { ...params, offset, limit: PAGE_SIZE }, signal),
  });
  const filtered = Boolean(dateFrom || dateTo);

  return (
    <>
      <PageHeader
        title="Verifactu"
        description="Registros de facturación encadenados con huella SHA-256. El envío a la AEAT está pendiente de activar."
      />
      <ChainCheck />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:max-w-md">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Fecha desde
          <Input
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(event) => {
              setDateFrom(event.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Fecha hasta
          <Input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(event) => {
              setDateTo(event.target.value);
              setOffset(0);
            }}
          />
        </label>
      </div>

      {query.isPending ? (
        <LoadingBlock rows={6} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? "Sin registros en esas fechas" : "Todavía no hay registros"}
          description={filtered ? "Prueba con otras fechas." : "Cada factura o abono emitido y cada anulación crean un registro."}
        />
      ) : (
        <>
          <DataList rows={query.data.items} columns={COLUMNS} rowKey={(row) => row.id} />
          <Pagination offset={offset} limit={PAGE_SIZE} total={query.data.total} onChange={setOffset} />
        </>
      )}
    </>
  );
}
