"use client";

/** Piezas compartidas de la pantalla Ajustes → Documentos (`docs/api-documentos.md`). */

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { AlertTriangle, Cloud, Cloudy, Network, Server, type LucideIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { friendlyMessage, isApiError, messageForCode } from "@/lib/errors";
import type { OAuthProvider, StorageProvider, TenantStorage, TenantStorageUpdate } from "@/types/documents";

export const STORAGE_KEY = ["tenant-storage"] as const;
export const ENDPOINT = "/tenant/storage";
export const PAGE_PATH = "/ajustes/documentos";

export const PROVIDER_ICONS: Record<StorageProvider, LucideIcon> = {
  platform: Server,
  google_drive: Cloud,
  onedrive: Cloudy,
  smb: Network,
};

export const PROVIDER_DESCRIPTIONS: Record<StorageProvider, string> = {
  platform: "En el servidor de Konygest. No hay que configurar nada.",
  google_drive: "En una carpeta de tu Google Drive o de una unidad compartida.",
  onedrive: "En tu OneDrive o en una biblioteca de SharePoint.",
  smb: "En una carpeta compartida de tu red (NAS o servidor de ficheros).",
};

export const OAUTH_BUTTON_LABELS: Record<OAuthProvider, string> = {
  google_drive: "Conectar con Google",
  onedrive: "Conectar con Microsoft",
};

/** Errores propios de la vuelta de OAuth (`?error=`), además de los códigos estándar de la API. */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Has cancelado la conexión: no se ha conectado ninguna cuenta.",
  INVALID_STATE: "La conexión ha caducado (tienes 10 minutos). Vuelve a pulsar «Conectar».",
  INVALID_TOKEN: "La conexión ha caducado (tienes 10 minutos). Vuelve a pulsar «Conectar».",
  OAUTH_FAILED: "Google o Microsoft no han aceptado la conexión. Vuelve a intentarlo.",
};

export function isOAuthProvider(value: string | null): value is OAuthProvider {
  return value === "google_drive" || value === "onedrive";
}

/** Mensaje amigable para el `?error=<código>` con el que vuelve el callback de OAuth. */
export function oauthErrorMessage(code: string): string {
  return (
    OAUTH_ERROR_MESSAGES[code] ??
    messageForCode(code) ??
    "No se pudo conectar la cuenta. Vuelve a intentarlo y, si sigue fallando, contacta con Klyp."
  );
}

export function settingString(config: TenantStorage, key: string): string {
  const value = config.settings?.[key];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/** Dónde se guardan los documentos, en una línea (cuenta, carpeta o servidor). */
export function locationSummary(config: TenantStorage): string {
  switch (config.provider) {
    case "platform":
      return "Servidor de Konygest";
    case "google_drive": {
      const folder = settingString(config, "root_folder_name") || "Konygest";
      const drive = settingString(config, "shared_drive_id");
      return `Carpeta «${folder}»${drive ? " en una unidad compartida" : ""}`;
    }
    case "onedrive": {
      const path = settingString(config, "root_path") || "/Konygest";
      const site = settingString(config, "site_url");
      return site ? `${site} · ${path}` : path;
    }
    case "smb": {
      const server = settingString(config, "server");
      const share = settingString(config, "share");
      const root = settingString(config, "root_path");
      return `\\\\${server}\\${share}${root ? `\\${root.replace(/^[\\/]+/, "").replace(/\//g, "\\")}` : ""}`;
    }
  }
}

export function invalidateStorage(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: STORAGE_KEY });
}
export function useSaveStorage(onConnectionFailed?: (message: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: TenantStorageUpdate) => api.put<TenantStorage>(ENDPOINT, payload),
    onSuccess: (saved) => {
      queryClient.setQueryData(STORAGE_KEY, saved);
      toast.success("Destino de los documentos guardado.");
    },
    onError: (error) => {
      if (onConnectionFailed && isApiError(error, "STORAGE_CONNECTION_FAILED")) {
        onConnectionFailed(error.message);
        return;
      }
      toast.error(friendlyMessage(error));
    },
  });
}

export function ConnectionFailedAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm md:col-span-2"
      role="alert"
      data-testid="connection-failed"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">No se pudo conectar con la carpeta. No se ha guardado nada.</p>
        <p className="break-words text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
