"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorState, Field, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { friendlyMessage, isApiError } from "@/lib/errors";
import { emailSchema } from "@/lib/schemas";
import type { EmailConfig } from "@/types/api";

const emptyConfig: EmailConfig = {
  host: "",
  port: 587,
  username: "",
  has_password: false,
  use_tls: true,
  from_email: "",
  from_name: "",
};

const configSchema = z.object({
  host: z.string().trim().min(1, "Indica el servidor SMTP."),
  port: z.number({ error: "Indica el puerto." }).int().min(1, "Puerto no válido.").max(65535, "Puerto no válido."),
  username: z.string().trim(),
  password: z.string(),
  use_tls: z.boolean(),
  from_email: emailSchema,
  from_name: z.string().trim().min(1, "Indica el nombre del remitente."),
});
type ConfigValues = z.infer<typeof configSchema>;

const testSchema = z.object({ to: emailSchema });
type TestValues = z.infer<typeof testSchema>;

function toFormValues(config: EmailConfig): ConfigValues {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    password: "",
    use_tls: config.use_tls,
    from_email: config.from_email,
    from_name: config.from_name,
  };
}

interface EmailConfigFormProps {
  /** Base de la ruta: /tenant/email-config (propio) o /admin/email-config (global). */
  endpoint: string;
  title: string;
  description: string;
  /** Si hay DELETE para volver al servidor de la plataforma (solo en empresas). */
  canReset?: boolean;
}

export function EmailConfigForm({ endpoint, title, description, canReset = false }: EmailConfigFormProps) {
  const queryClient = useQueryClient();
  const queryKey = ["email-config", endpoint] as const;
  const [confirmReset, setConfirmReset] = useState(false);

  const query = useQuery({
    queryKey,
    // Una empresa sin SMTP propio puede devolver 404: se muestra el formulario vacío.
    queryFn: async ({ signal }) => {
      try {
        return await api.get<EmailConfig>(endpoint, undefined, signal);
      } catch (error) {
        if (isApiError(error, "NOT_FOUND")) return null;
        throw error;
      }
    },
  });

  const config = query.data ?? emptyConfig;
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isDirty },
  } = useForm<ConfigValues>({ resolver: zodResolver(configSchema), defaultValues: toFormValues(config) });

  useEffect(() => {
    if (query.data !== undefined) reset(toFormValues(query.data ?? emptyConfig));
  }, [query.data, reset]);

  const testForm = useForm<TestValues>({ resolver: zodResolver(testSchema), defaultValues: { to: "" } });

  const save = useMutation({
    mutationFn: (values: ConfigValues) => {
      const { password, ...rest } = values;
      // Contraseña vacía = conservar la guardada.
      return api.put<EmailConfig>(endpoint, password ? { ...rest, password } : rest);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKey, saved);
      toast.success("Configuración de correo guardada.");
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  const sendTest = useMutation({
    mutationFn: (values: TestValues) => api.post(`${endpoint}/test`, values),
    onSuccess: () => toast.success("Email de prueba enviado. Revisa la bandeja de entrada."),
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  const resetToPlatform = useMutation({
    mutationFn: () => api.delete(endpoint),
    onSuccess: () => {
      queryClient.setQueryData(queryKey, null);
      setConfirmReset(false);
      toast.success("Se usará el servidor de correo de la plataforma.");
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  if (query.isPending) return <LoadingBlock rows={4} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  const hasSaved = query.data !== null && query.data !== undefined;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          {canReset && !hasSaved ? (
            <p className="mb-4 rounded-md bg-muted p-3 text-sm">
              Ahora se usa el servidor de correo de la plataforma. Rellena el formulario si prefieres el tuyo.
            </p>
          ) : null}
          <form onSubmit={handleSubmit((values) => save.mutate(values))} className="grid max-w-2xl gap-4 md:grid-cols-2" noValidate>
            <Field label="Servidor SMTP" htmlFor="host" error={errors.host?.message}>
              <Input id="host" autoComplete="off" placeholder="smtp.ejemplo.com" {...register("host")} />
            </Field>
            <Field label="Puerto" htmlFor="port" error={errors.port?.message}>
              <Input id="port" type="number" inputMode="numeric" {...register("port", { valueAsNumber: true })} />
            </Field>
            <Field label="Usuario" htmlFor="username" error={errors.username?.message}>
              <Input id="username" autoComplete="off" {...register("username")} />
            </Field>
            <Field
              label="Contraseña"
              htmlFor="smtp-password"
              error={errors.password?.message}
              hint={config.has_password ? "Hay una contraseña guardada. Déjalo vacío para conservarla." : undefined}
            >
              <Input id="smtp-password" type="password" autoComplete="new-password" {...register("password")} />
            </Field>
            <Field label="Email del remitente" htmlFor="from_email" error={errors.from_email?.message}>
              <Input id="from_email" type="email" {...register("from_email")} />
            </Field>
            <Field label="Nombre del remitente" htmlFor="from_name" error={errors.from_name?.message}>
              <Input id="from_name" {...register("from_name")} />
            </Field>
            <div className="flex min-h-11 items-center gap-3 md:col-span-2">
              <Switch
                id="use_tls"
                checked={watch("use_tls")}
                onCheckedChange={(value) => setValue("use_tls", value, { shouldDirty: true })}
              />
              <label htmlFor="use_tls" className="text-sm">
                Usar conexión segura (TLS)
              </label>
            </div>
            <div className="flex flex-wrap gap-2 md:col-span-2">
              <Button type="submit" disabled={!isDirty} loading={save.isPending}>
                Guardar
              </Button>
              {canReset && hasSaved ? (
                <Button type="button" variant="outline" onClick={() => setConfirmReset(true)}>
                  Usar el servidor de la plataforma
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Enviar email de prueba</CardTitle>
          <CardDescription>Guarda primero la configuración y comprueba que llega el mensaje.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={testForm.handleSubmit((values) => sendTest.mutate(values))}
            className="flex max-w-lg flex-col gap-3 sm:flex-row sm:items-start"
            noValidate
          >
            <div className="flex-1">
              <Field label="Enviar a" htmlFor="test-to" error={testForm.formState.errors.to?.message}>
                <Input id="test-to" type="email" autoComplete="email" {...testForm.register("to")} />
              </Field>
            </div>
            <Button type="submit" variant="outline" loading={sendTest.isPending} className="sm:mt-[1.625rem]">
              <Send aria-hidden /> Enviar prueba
            </Button>
          </form>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Usar el servidor de la plataforma"
        description="Se borrará tu configuración SMTP propia y los emails saldrán por el servidor de Klyp."
        confirmLabel="Borrar y usar el de la plataforma"
        destructive
        loading={resetToPlatform.isPending}
        onConfirm={() => resetToPlatform.mutate()}
      />
    </div>
  );
}
