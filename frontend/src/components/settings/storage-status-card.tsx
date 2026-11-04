"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, PlugZap } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { STORAGE_PROVIDER_LABELS, STORAGE_STATUS_LABELS, STORAGE_STATUS_VARIANTS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { StorageTestResult, TenantStorage } from "@/types/documents";

import { ENDPOINT, invalidateStorage, locationSummary, PROVIDER_ICONS } from "./storage-common";

/** Estado del destino actual y botón «Probar conexión». */
export function StorageStatusCard({ config, canWrite }: { config: TenantStorage; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<StorageTestResult | null>(null);
  const Icon = PROVIDER_ICONS[config.provider];

  const test = useMutation({
    mutationFn: () => api.post<StorageTestResult>(`${ENDPOINT}/test`),
    onSuccess: (data) => {
      setResult(data);
      if (data.ok) toast.success(`${data.message} (${data.elapsed_ms} ms)`);
      else toast.error(data.message);
      void invalidateStorage(queryClient);
    },
    onError: (error) => {
      setResult(null);
      toast.error(friendlyMessage(error));
      void invalidateStorage(queryClient);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Destino actual</CardTitle>
        <CardDescription>Dónde se guardan ahora los albaranes, las órdenes de carga y, más adelante, las facturas.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-klyp-pale text-klyp-navy dark:bg-white/10 dark:text-white">
              <Icon className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                <span data-testid="current-provider">{STORAGE_PROVIDER_LABELS[config.provider]}</span>
                <Badge variant={STORAGE_STATUS_VARIANTS[config.status]}>{STORAGE_STATUS_LABELS[config.status]}</Badge>
              </p>
              {config.connected_account ? (
                <p className="break-all text-sm">Cuenta: {config.connected_account}</p>
              ) : null}
              <p className="break-all text-sm text-muted-foreground">{locationSummary(config)}</p>
            </div>
          </div>
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => test.mutate()}
            loading={test.isPending}
            disabled={!canWrite}
          >
            <PlugZap aria-hidden /> Probar conexión
          </Button>
        </div>

        {config.status === "error" && config.last_error ? (
          <div className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alert">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0">
              <p className="font-medium">El último intento de guardar o probar falló</p>
              <p className="break-words text-muted-foreground">{config.last_error}</p>
              <p className="mt-1 text-muted-foreground">
                Mientras tanto los documentos se guardan en el almacenamiento de Konygest para no perderlos.
              </p>
            </div>
          </div>
        ) : null}

        {result ? (
          <p className={cn("text-sm", result.ok ? "text-success" : "text-destructive")} aria-live="polite">
            {result.message} · {result.elapsed_ms} ms
          </p>
        ) : null}

        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Última comprobación</dt>
            <dd>{formatDateTime(config.last_checked_at)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Último cambio</dt>
            <dd>
              {config.updated_at
                ? `${formatDateTime(config.updated_at)}${config.updated_by_name ? ` · ${config.updated_by_name}` : ""}`
                : "—"}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
