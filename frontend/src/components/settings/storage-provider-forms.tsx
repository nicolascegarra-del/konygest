"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Field } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { STORAGE_PROVIDER_LABELS } from "@/lib/labels";
import type { OAuthProvider, OAuthStartResult, SmbSettings, TenantStorage, TenantStorageUpdate } from "@/types/documents";

import {
  ConnectionFailedAlert,
  ENDPOINT,
  invalidateStorage,
  OAUTH_BUTTON_LABELS,
  settingString,
  useSaveStorage,
} from "./storage-common";

/**
 * Inicia la conexión OAuth. Con `sharepoint` (solo OneDrive) se pide además acceso a los sitios
 * de SharePoint (`Sites.ReadWrite.All`), que el backend solo solicita cuando hace falta.
 */
function useOAuthStart() {
  return useMutation({
    mutationFn: ({ provider, sharepoint = false }: { provider: OAuthProvider; sharepoint?: boolean }) =>
      api.post<OAuthStartResult>(`${ENDPOINT}/oauth/${provider}/start${sharepoint ? "?sharepoint=true" : ""}`),
    onSuccess: ({ authorize_url }) => window.location.assign(authorize_url),
    onError: (error) => toast.error(friendlyMessage(error)),
  });
}

const driveSchema = z.object({
  root_folder_name: z.string().trim().min(1, "Indica el nombre de la carpeta.").max(120, "Nombre demasiado largo."),
  shared_drive_id: z.string().trim().max(200),
});
type DriveValues = z.infer<typeof driveSchema>;

const oneDriveSchema = z.object({
  root_path: z.string().trim().min(1, "Indica la ruta de la carpeta.").max(250, "Ruta demasiado larga."),
  site_url: z
    .string()
    .trim()
    .refine((value) => value === "" || /^https:\/\/[^\s/]+\.[^\s]+$/i.test(value), "Debe ser una URL https:// de SharePoint."),
});
type OneDriveValues = z.infer<typeof oneDriveSchema>;

export function OAuthPanel({
  provider,
  config,
  canWrite,
}: {
  provider: OAuthProvider;
  config: TenantStorage;
  canWrite: boolean;
}) {
  const start = useOAuthStart();
  const connected = config.provider === provider && !!config.connected_account;
  const connectLabel = OAUTH_BUTTON_LABELS[provider];
  const redirecting = start.isPending || start.isSuccess;
  const sharepoint = provider === "onedrive" && !!settingString(config, "site_url");

  if (!connected) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {provider === "google_drive"
            ? "Te llevaremos a Google para que elijas la cuenta. Konygest solo podrá ver los ficheros y carpetas que cree él mismo."
            : "Te llevaremos a Microsoft para que elijas la cuenta de trabajo o personal donde guardar los documentos."}
        </p>
        <Button className="w-full sm:w-auto" onClick={() => start.mutate({ provider, sharepoint })} loading={redirecting} disabled={!canWrite}>
          {connectLabel}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-md bg-muted p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 break-all">
          Cuenta conectada: <span className="font-medium">{config.connected_account}</span>
        </p>
        <Button
          variant="outline"
          size="sm"
          className="w-full sm:w-auto"
          onClick={() => start.mutate({ provider, sharepoint })}
          loading={redirecting}
          disabled={!canWrite}
        >
          Cambiar de cuenta
        </Button>
      </div>
      {provider === "google_drive" ? (
        <DriveForm key={config.updated_at ?? "drive"} config={config} canWrite={canWrite} />
      ) : (
        <OneDriveForm key={config.updated_at ?? "onedrive"} config={config} canWrite={canWrite} />
      )}
    </div>
  );
}

function DriveForm({ config, canWrite }: { config: TenantStorage; canWrite: boolean }) {
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const save = useSaveStorage(setConnectionError);
  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm<DriveValues>({
    resolver: zodResolver(driveSchema),
    defaultValues: {
      root_folder_name: settingString(config, "root_folder_name") || "Konygest",
      shared_drive_id: settingString(config, "shared_drive_id"),
    },
  });
  return (
    <form
      onSubmit={handleSubmit((values) => {
        setConnectionError(null);
        save.mutate({
          provider: "google_drive",
          settings: { root_folder_name: values.root_folder_name, shared_drive_id: values.shared_drive_id || null },
        });
      })}
      className="grid gap-4 md:grid-cols-2"
      noValidate
    >
      <Field
        label="Carpeta raíz"
        htmlFor="drive-root"
        error={errors.root_folder_name?.message}
        hint="Dentro se crean Albaranes/2026/…, Ordenes de carga/2026/…"
      >
        <Input id="drive-root" disabled={!canWrite} {...register("root_folder_name")} />
      </Field>
      <Field
        label="Unidad compartida (opcional)"
        htmlFor="drive-shared"
        error={errors.shared_drive_id?.message}
        hint="Id de la unidad compartida. Vacío = «Mi unidad» de la cuenta conectada."
      >
        <Input id="drive-shared" autoComplete="off" disabled={!canWrite} {...register("shared_drive_id")} />
      </Field>
      <ConnectionFailedAlert message={connectionError} />
      <div className="md:col-span-2">
        <Button type="submit" className="w-full sm:w-auto" disabled={!canWrite || (!isDirty && config.provider === "google_drive")} loading={save.isPending}>
          Guardar
        </Button>
      </div>
    </form>
  );
}

function OneDriveForm({ config, canWrite }: { config: TenantStorage; canWrite: boolean }) {
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const save = useSaveStorage(setConnectionError);
  const start = useOAuthStart();
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isDirty },
  } = useForm<OneDriveValues>({
    resolver: zodResolver(oneDriveSchema),
    defaultValues: {
      root_path: settingString(config, "root_path") || "/Konygest",
      site_url: settingString(config, "site_url"),
    },
  });
  return (
    <form
      onSubmit={handleSubmit((values) => {
        setConnectionError(null);
        save.mutate({
          provider: "onedrive",
          settings: { root_path: values.root_path, site_url: values.site_url || null },
        });
      })}
      className="grid gap-4 md:grid-cols-2"
      noValidate
    >
      <Field label="Ruta raíz" htmlFor="onedrive-root" error={errors.root_path?.message} hint="Por ejemplo /Konygest.">
        <Input id="onedrive-root" disabled={!canWrite} {...register("root_path")} />
      </Field>
      <Field
        label="Sitio de SharePoint (opcional)"
        htmlFor="onedrive-site"
        error={errors.site_url?.message}
        hint="Si lo indicas, se usa la biblioteca de documentos del sitio en lugar de tu OneDrive."
      >
        <Input
          id="onedrive-site"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://empresa.sharepoint.com/sites/documentos"
          disabled={!canWrite}
          {...register("site_url")}
        />
      </Field>
      <ConnectionFailedAlert message={connectionError} />
      {connectionError && watch("site_url") ? (
        // La primera vez que se usa un sitio, la cuenta puede no haber concedido acceso a SharePoint
        <div className="flex flex-col gap-2 rounded-md bg-muted p-3 text-sm md:col-span-2 sm:flex-row sm:items-center sm:justify-between">
          <p>Si es la primera vez que usas un sitio de SharePoint, Microsoft tiene que autorizar el acceso a sus sitios.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full shrink-0 sm:w-auto"
            onClick={() => start.mutate({ provider: "onedrive", sharepoint: true })}
            loading={start.isPending || start.isSuccess}
            disabled={!canWrite}
          >
            Dar acceso a SharePoint
          </Button>
        </div>
      ) : null}
      <div className="md:col-span-2">
        <Button type="submit" className="w-full sm:w-auto" disabled={!canWrite || (!isDirty && config.provider === "onedrive")} loading={save.isPending}>
          Guardar
        </Button>
      </div>
    </form>
  );
}

function smbSchema(requirePassword: boolean) {
  return z.object({
    server: z.string().trim().min(1, "Indica el servidor (nombre o IP).").max(255),
    share: z.string().trim().min(1, "Indica el recurso compartido.").max(255),
    root_path: z.string().trim().max(255),
    username: z.string().trim().min(1, "Indica el usuario.").max(255),
    domain: z.string().trim().max(255),
    port: z
      .string()
      .trim()
      .refine((value) => value === "" || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535), "Puerto no válido."),
    password: requirePassword ? z.string().min(1, "Indica la contraseña.") : z.string(),
  });
}
export type SmbValues = z.infer<ReturnType<typeof smbSchema>>;

/**
 * Cuerpo del `PUT` para una carpeta SMB. La contraseña vacía se omite: al editar una
 * configuración SMB ya guardada, el backend conserva la contraseña anterior.
 */
export function buildSmbPayload(values: SmbValues): TenantStorageUpdate {
  const settings: SmbSettings = {
    server: values.server.trim(),
    share: values.share.trim(),
    root_path: values.root_path.trim() || "Konygest",
    username: values.username.trim(),
    domain: values.domain.trim() || null,
    port: values.port.trim() ? Number(values.port) : null,
  };
  return values.password ? { provider: "smb", settings, password: values.password } : { provider: "smb", settings };
}

export function SmbForm({ config, canWrite }: { config: TenantStorage; canWrite: boolean }) {
  const editing = config.provider === "smb";
  const keepsPassword = editing && config.has_secret;
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const save = useSaveStorage(setConnectionError);
  const schema = useMemo(() => smbSchema(!keepsPassword), [keepsPassword]);
  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm<SmbValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      server: editing ? settingString(config, "server") : "",
      share: editing ? settingString(config, "share") : "",
      root_path: editing ? settingString(config, "root_path") || "Konygest" : "Konygest",
      username: editing ? settingString(config, "username") : "",
      domain: editing ? settingString(config, "domain") : "",
      port: editing ? settingString(config, "port") : "",
      password: "",
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex gap-3 rounded-md bg-muted p-3 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p>
          El servidor de Konygest tiene que poder llegar a esa carpeta: con una IP pública, una VPN o Tailscale. Una
          carpeta de un PC concreto solo sirve si ese PC la comparte en red o la sincroniza con Google Drive u OneDrive.
        </p>
      </div>
      <form
        onSubmit={handleSubmit((values) => {
          setConnectionError(null);
          save.mutate(buildSmbPayload(values));
        })}
        className="grid gap-4 md:grid-cols-2"
        noValidate
      >
        <Field label="Servidor" htmlFor="smb-server" error={errors.server?.message} hint="Nombre o IP, p. ej. nas.miempresa.es">
          <Input id="smb-server" autoComplete="off" disabled={!canWrite} {...register("server")} />
        </Field>
        <Field label="Recurso compartido" htmlFor="smb-share" error={errors.share?.message} hint="Por ejemplo documentos">
          <Input id="smb-share" autoComplete="off" disabled={!canWrite} {...register("share")} />
        </Field>
        <Field label="Ruta raíz" htmlFor="smb-root" error={errors.root_path?.message} hint="Carpeta dentro del recurso. Vacío = Konygest.">
          <Input id="smb-root" autoComplete="off" disabled={!canWrite} {...register("root_path")} />
        </Field>
        <Field label="Usuario" htmlFor="smb-username" error={errors.username?.message}>
          <Input id="smb-username" autoComplete="off" disabled={!canWrite} {...register("username")} />
        </Field>
        <Field label="Dominio (opcional)" htmlFor="smb-domain" error={errors.domain?.message}>
          <Input id="smb-domain" autoComplete="off" disabled={!canWrite} {...register("domain")} />
        </Field>
        <Field label="Puerto (opcional)" htmlFor="smb-port" error={errors.port?.message} hint="Vacío = 445.">
          <Input id="smb-port" inputMode="numeric" autoComplete="off" placeholder="445" disabled={!canWrite} {...register("port")} />
        </Field>
        <Field
          label="Contraseña"
          htmlFor="smb-password"
          error={errors.password?.message}
          hint={keepsPassword ? "Hay una contraseña guardada. Déjalo vacío para conservarla." : "Se guarda cifrada y no se vuelve a mostrar."}
        >
          <Input id="smb-password" type="password" autoComplete="new-password" disabled={!canWrite} {...register("password")} />
        </Field>
        <ConnectionFailedAlert message={connectionError} />
        <div className="md:col-span-2">
          <p className="mb-2 text-xs text-muted-foreground">Al guardar se prueba la conexión; si falla, no se cambia nada.</p>
          <Button type="submit" className="w-full sm:w-auto" disabled={!canWrite || (editing && !isDirty)} loading={save.isPending}>
            Probar y guardar
          </Button>
        </div>
      </form>
    </div>
  );
}

export function PlatformPanel({ config, canWrite }: { config: TenantStorage; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const reset = useMutation({
    mutationFn: () => api.delete(ENDPOINT),
    onSuccess: async () => {
      setConfirm(false);
      await invalidateStorage(queryClient);
      toast.success("Los documentos nuevos se guardarán en el almacenamiento de Konygest.");
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });
  const isCurrent = config.provider === "platform";

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Los documentos se guardan en el servidor de Konygest, con copia de seguridad. No hay que conectar nada.
      </p>
      {isCurrent ? (
        <p className="text-sm font-medium">Es el destino que usas ahora.</p>
      ) : (
        <Button className="w-full sm:w-auto" onClick={() => setConfirm(true)} disabled={!canWrite}>
          Usar este
        </Button>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Volver al almacenamiento de Konygest"
        description={`Se desconectará ${STORAGE_PROVIDER_LABELS[config.provider]} y se borrarán sus credenciales. Los documentos ya guardados allí se quedan donde están y se podrán seguir abriendo.`}
        confirmLabel="Usar Konygest"
        destructive
        loading={reset.isPending}
        onConfirm={() => reset.mutate()}
      />
    </div>
  );
}
