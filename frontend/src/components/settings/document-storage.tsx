"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { can } from "@/lib/auth";
import { STORAGE_PROVIDER_LABELS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import type { OAuthProvider, StorageProvider, TenantStorage } from "@/types/documents";

import {
  ENDPOINT,
  invalidateStorage,
  isOAuthProvider,
  oauthErrorMessage,
  PAGE_PATH,
  PROVIDER_DESCRIPTIONS,
  PROVIDER_ICONS,
  STORAGE_KEY,
} from "./storage-common";
import { OAuthPanel, PlatformPanel, SmbForm } from "./storage-provider-forms";
import { StorageStatusCard } from "./storage-status-card";
import { StoredDocumentsCard } from "./stored-documents-card";

// ─── Elegir destino ────────────────────────────────

function DestinationCard({
  config,
  canWrite,
  selected,
  onSelect,
}: {
  config: TenantStorage;
  canWrite: boolean;
  selected: StorageProvider;
  onSelect: (provider: StorageProvider) => void;
}) {
  const providers = config.available_providers.length > 0 ? config.available_providers : (["platform"] as StorageProvider[]);
  const changing = selected !== config.provider;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Elegir destino</CardTitle>
        <CardDescription>Los documentos se guardan en carpetas por tipo y año: Albaranes/2026/ALB-2026-0001.pdf</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <fieldset>
          <legend className="sr-only">Destino de los documentos</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {providers.map((provider) => {
              const Icon = PROVIDER_ICONS[provider];
              const id = `storage-provider-${provider}`;
              return (
                <label
                  key={provider}
                  htmlFor={id}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors hover:bg-accent/40",
                    "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                    selected === provider && "border-primary bg-accent/40",
                  )}
                >
                  <input
                    id={id}
                    type="radio"
                    name="storage-provider"
                    value={provider}
                    checked={selected === provider}
                    onChange={() => onSelect(provider)}
                    className="sr-only"
                  />
                  <Icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {STORAGE_PROVIDER_LABELS[provider]}
                      {provider === config.provider ? <Badge variant="secondary">Actual</Badge> : null}
                    </span>
                    <span className="block text-sm text-muted-foreground">{PROVIDER_DESCRIPTIONS[provider]}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {changing ? (
          <div className="flex gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" role="note">
            <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <p>
              Al cambiar de destino, los documentos ya guardados siguen donde están y se podrán seguir abriendo. Solo los
              nuevos se guardarán en {STORAGE_PROVIDER_LABELS[selected]}.
            </p>
          </div>
        ) : null}

        <section aria-label={`Ajustes de ${STORAGE_PROVIDER_LABELS[selected]}`}>
          {selected === "platform" ? <PlatformPanel config={config} canWrite={canWrite} /> : null}
          {isOAuthProvider(selected) ? <OAuthPanel provider={selected} config={config} canWrite={canWrite} /> : null}
          {selected === "smb" ? <SmbForm key={config.updated_at ?? "smb"} config={config} canWrite={canWrite} /> : null}
        </section>
      </CardContent>
    </Card>
  );
}

// ─── Pantalla ──────────────────────────────────────

/**
 * Avisa del resultado de la vuelta de OAuth (`?connected=` / `?error=`), deja seleccionado el
 * proveedor recién conectado y limpia la URL para que el aviso no se repita al recargar.
 */
function useOAuthReturn(onConnected: (provider: OAuthProvider) => void) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const connected = searchParams.get("connected");
  const oauthError = searchParams.get("error");
  // En desarrollo (StrictMode) los efectos se ejecutan dos veces: un solo toast por vuelta.
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!connected && !oauthError) return;
    const signature = `${connected ?? ""}|${oauthError ?? ""}`;
    if (handled.current === signature) return;
    handled.current = signature;
    if (oauthError) {
      toast.error(oauthErrorMessage(oauthError));
    } else if (isOAuthProvider(connected)) {
      toast.success(`Cuenta de ${STORAGE_PROVIDER_LABELS[connected]} conectada. Los documentos nuevos se guardarán allí.`);
      onConnected(connected);
    }
    void invalidateStorage(queryClient);
    router.replace(PAGE_PATH);
  }, [connected, oauthError, onConnected, queryClient, router]);
}

/** Ajustes → Documentos: destino donde se guardan los documentos de la empresa. */
export function DocumentStorageSettings() {
  const me = useAuthStore((state) => state.user);
  const allowed = can(me, "empresa.configurar");
  const canWrite = allowed && !me?.read_only;
  const [selected, setSelected] = useState<StorageProvider | null>(null);
  useOAuthReturn(setSelected);

  const query = useQuery({
    queryKey: STORAGE_KEY,
    enabled: allowed,
    queryFn: ({ signal }) => api.get<TenantStorage>(ENDPOINT, undefined, signal),
  });

  if (!allowed) {
    return <EmptyState title="No tienes permiso para configurar los documentos" description="Pide acceso a quien administre tu empresa." />;
  }
  if (query.isPending) return <LoadingBlock rows={4} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  const config = query.data;
  const current = selected && config.available_providers.includes(selected) ? selected : config.provider;

  return (
    <div className="space-y-6">
      {me?.read_only ? (
        <p className="rounded-md bg-muted p-3 text-sm" role="status">
          La cuenta está en solo lectura: puedes ver la configuración pero no cambiarla.
        </p>
      ) : null}
      <StorageStatusCard config={config} canWrite={canWrite} />
      <DestinationCard config={config} canWrite={canWrite} selected={current} onSelect={setSelected} />
      <StoredDocumentsCard />
    </div>
  );
}
