"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ErrorState, Field, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { reloadMe } from "@/lib/auth";
import { friendlyMessage } from "@/lib/errors";
import type { Tenant } from "@/types/api";

export const TENANT_KEY = ["tenant"] as const;

const companySchema = z.object({
  name: z.string().trim().min(2, "Indica el nombre de la empresa.").max(150),
  tax_id: z.string().trim().max(30),
  require_2fa: z.boolean(),
});
type CompanyValues = z.infer<typeof companySchema>;

function CompanyForm({ tenant }: { tenant: Tenant }) {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isDirty },
  } = useForm<CompanyValues>({
    resolver: zodResolver(companySchema),
    defaultValues: { name: tenant.name, tax_id: tenant.tax_id ?? "", require_2fa: tenant.require_2fa },
  });

  const save = useMutation({
    mutationFn: (values: CompanyValues) =>
      api.patch<Tenant>("/tenant", { name: values.name, tax_id: values.tax_id || null, require_2fa: values.require_2fa }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(TENANT_KEY, updated);
      reset({ name: updated.name, tax_id: updated.tax_id ?? "", require_2fa: updated.require_2fa });
      await reloadMe();
      toast.success("Datos de la empresa guardados.");
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Datos de la empresa</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit((values) => save.mutate(values))} className="max-w-lg space-y-4" noValidate>
          <Field label="Nombre" htmlFor="name" error={errors.name?.message}>
            <Input id="name" autoComplete="organization" {...register("name")} />
          </Field>
          <Field label="CIF / NIF" htmlFor="tax_id" error={errors.tax_id?.message}>
            <Input id="tax_id" {...register("tax_id")} />
          </Field>
          <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div>
              <label htmlFor="require_2fa" className="text-sm font-medium">
                Exigir verificación en dos pasos
              </label>
              <p className="text-sm text-muted-foreground">
                Todos los usuarios tendrán que activarla antes de seguir usando la aplicación.
              </p>
            </div>
            <Switch
              id="require_2fa"
              checked={watch("require_2fa")}
              onCheckedChange={(value) => setValue("require_2fa", value, { shouldDirty: true })}
            />
          </div>
          <Button type="submit" disabled={!isDirty} loading={save.isPending}>
            Guardar cambios
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ModulesCard({ tenant }: { tenant: Tenant }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: ({ code, enabled }: { code: string; enabled: boolean }) =>
      api.put(`/tenant/modules/${code}`, { enabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: TENANT_KEY });
      await queryClient.invalidateQueries({ queryKey: ["permissions"] });
      await reloadMe();
      toast.success("Módulo actualizado.");
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Módulos</CardTitle>
        <CardDescription>
          Activa los módulos opcionales que usa tu empresa. Al apagar uno desaparecen sus menús, widgets y permisos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {tenant.modules.map((module) => (
            <li key={module.code} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <label htmlFor={`module-${module.code}`} className="text-sm font-medium">
                  {module.name}
                </label>
                <p className="text-sm text-muted-foreground">{module.description}</p>
                {!module.available ? (
                  <p className="mt-1 text-xs text-muted-foreground">No incluido en tu plan. Contacta con Klyp para activarlo.</p>
                ) : null}
              </div>
              <Switch
                id={`module-${module.code}`}
                checked={module.enabled}
                disabled={!module.available || toggle.isPending}
                onCheckedChange={(enabled) => toggle.mutate({ code: module.code, enabled })}
              />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function CompanySettings() {
  const query = useQuery({
    queryKey: TENANT_KEY,
    queryFn: ({ signal }) => api.get<Tenant>("/tenant", undefined, signal),
  });
  if (query.isPending) return <LoadingBlock rows={4} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return (
    <div className="space-y-6">
      <CompanyForm tenant={query.data} />
      <ModulesCard tenant={query.data} />
    </div>
  );
}
