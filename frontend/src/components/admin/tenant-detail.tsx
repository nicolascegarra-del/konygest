"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, LifeBuoy } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorState, Field, LoadingBlock, PageHeader } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { reloadMe } from "@/lib/auth";
import { friendlyMessage } from "@/lib/errors";
import { TENANT_STATUS_LABELS, TENANT_STATUS_VARIANTS, TENANT_STATUSES } from "@/lib/labels";
import { useAuthStore } from "@/stores/auth-store";
import type { Tenant, TenantStatus } from "@/types/api";

const detailsSchema = z.object({
  name: z.string().trim().min(2, "Indica el nombre de la empresa.").max(150),
  tax_id: z.string().trim().max(30),
  plan_code: z.string().trim().max(50),
  require_2fa: z.boolean(),
});
type DetailsValues = z.infer<typeof detailsSchema>;

function statusConfirmText(target: TenantStatus): string {
  if (target === "disabled") {
    return "Nadie de esta empresa podrá acceder mientras esté desactivada. Los datos se conservan.";
  }
  if (target === "active") return "La empresa pasará a estar activa y sus usuarios podrán acceder.";
  return `La empresa pasará al estado «${TENANT_STATUS_LABELS[target]}».`;
}

export function TenantDetail({ tenantId }: { tenantId: string }) {
  const queryKey = ["admin", "tenant", tenantId] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.get<Tenant>(`/admin/tenants/${tenantId}`, undefined, signal),
  });

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-3">
        <Link href="/admin/empresas">
          <ArrowLeft aria-hidden /> Empresas
        </Link>
      </Button>
      {query.isPending ? (
        <LoadingBlock rows={5} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <TenantDetailContent tenant={query.data} queryKey={queryKey} />
      )}
    </>
  );
}

function TenantDetailContent({ tenant, queryKey }: { tenant: Tenant; queryKey: readonly string[] }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [targetStatus, setTargetStatus] = useState<TenantStatus>(tenant.status);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [confirmSupport, setConfirmSupport] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isDirty },
  } = useForm<DetailsValues>({
    resolver: zodResolver(detailsSchema),
    defaultValues: {
      name: tenant.name,
      tax_id: tenant.tax_id ?? "",
      plan_code: tenant.plan_code ?? "",
      require_2fa: tenant.require_2fa,
    },
  });

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<Tenant>(`/admin/tenants/${tenant.id}`, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKey, updated);
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "stats"] });
      reset({
        name: updated.name,
        tax_id: updated.tax_id ?? "",
        plan_code: updated.plan_code ?? "",
        require_2fa: updated.require_2fa,
      });
      setTargetStatus(updated.status);
      setConfirmStatus(false);
      toast.success("Empresa actualizada.");
    },
    onError: (error) => {
      setConfirmStatus(false);
      toast.error(friendlyMessage(error));
    },
  });

  const toggleModule = useMutation({
    mutationFn: ({ code, available, enabled }: { code: string; available: boolean; enabled: boolean }) =>
      api.put(`/admin/tenants/${tenant.id}/modules/${code}`, { available, enabled: available ? enabled : false }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  const enterSupport = useMutation({
    mutationFn: () => api.post<{ access_token: string }>(`/admin/tenants/${tenant.id}/support`),
    onSuccess: async ({ access_token }) => {
      const store = useAuthStore.getState();
      store.enterSupport(access_token);
      try {
        queryClient.clear();
        await reloadMe();
        router.push("/inicio");
      } catch (error) {
        // Si no se puede cargar el contexto de soporte, volver al token propio.
        store.exitSupport();
        toast.error(friendlyMessage(error));
      }
    },
    onError: (error) => {
      setConfirmSupport(false);
      toast.error(friendlyMessage(error));
    },
  });

  return (
    <>
      <PageHeader
        title={tenant.name}
        description={tenant.tax_id ? `CIF/NIF ${tenant.tax_id}` : undefined}
        actions={
          <>
            <Badge variant={TENANT_STATUS_VARIANTS[tenant.status]}>{TENANT_STATUS_LABELS[tenant.status]}</Badge>
            <Button variant="outline" onClick={() => setConfirmSupport(true)} disabled={tenant.status === "disabled"}>
              <LifeBuoy aria-hidden /> Entrar en modo soporte
            </Button>
          </>
        }
      />

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Datos y plan</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={handleSubmit((values) =>
                update.mutate({
                  name: values.name,
                  tax_id: values.tax_id || null,
                  plan_code: values.plan_code || null,
                  require_2fa: values.require_2fa,
                }),
              )}
              className="grid max-w-2xl gap-4 md:grid-cols-2"
              noValidate
            >
              <Field label="Nombre" htmlFor="name" error={errors.name?.message}>
                <Input id="name" {...register("name")} />
              </Field>
              <Field label="CIF / NIF" htmlFor="tax_id" error={errors.tax_id?.message}>
                <Input id="tax_id" {...register("tax_id")} />
              </Field>
              <Field label="Plan" htmlFor="plan_code" error={errors.plan_code?.message} hint="Código del plan asignado.">
                <Input id="plan_code" {...register("plan_code")} />
              </Field>
              <div className="flex min-h-11 items-center gap-3 self-end">
                <Switch
                  id="require_2fa"
                  checked={watch("require_2fa")}
                  onCheckedChange={(value) => setValue("require_2fa", value, { shouldDirty: true })}
                />
                <label htmlFor="require_2fa" className="text-sm">
                  Exigir 2FA a todos los usuarios
                </label>
              </div>
              <div className="md:col-span-2">
                <Button type="submit" disabled={!isDirty} loading={update.isPending && !confirmStatus}>
                  Guardar cambios
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Estado</CardTitle>
            <CardDescription>Una empresa desactivada no puede acceder; sus datos se conservan.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="sm:w-56">
              <label htmlFor="status" className="mb-1.5 block text-sm font-medium">
                Estado
              </label>
              <Select
                id="status"
                value={targetStatus}
                onChange={(event) => setTargetStatus(event.target.value as TenantStatus)}
              >
                {TENANT_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {TENANT_STATUS_LABELS[value]}
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="outline" disabled={targetStatus === tenant.status} onClick={() => setConfirmStatus(true)}>
              Cambiar estado
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Módulos</CardTitle>
            <CardDescription>
              «Disponible» decide si la empresa puede activarlo; «Activo» lo enciende para toda la empresa.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {tenant.modules.map((module) => (
                <li key={module.code} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{module.name}</p>
                    <p className="text-sm text-muted-foreground">{module.description}</p>
                  </div>
                  <div className="flex shrink-0 gap-6">
                    <div className="flex min-h-11 items-center gap-2">
                      <Switch
                        id={`available-${module.code}`}
                        checked={module.available}
                        disabled={toggleModule.isPending}
                        onCheckedChange={(available) =>
                          toggleModule.mutate({ code: module.code, available, enabled: module.enabled })
                        }
                      />
                      <label htmlFor={`available-${module.code}`} className="text-sm">
                        Disponible
                      </label>
                    </div>
                    <div className="flex min-h-11 items-center gap-2">
                      <Switch
                        id={`enabled-${module.code}`}
                        checked={module.enabled}
                        disabled={!module.available || toggleModule.isPending}
                        onCheckedChange={(enabled) =>
                          toggleModule.mutate({ code: module.code, available: module.available, enabled })
                        }
                      />
                      <label htmlFor={`enabled-${module.code}`} className="text-sm">
                        Activo
                      </label>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmStatus}
        onOpenChange={setConfirmStatus}
        title={`Cambiar estado a «${TENANT_STATUS_LABELS[targetStatus]}»`}
        description={statusConfirmText(targetStatus)}
        confirmLabel="Confirmar cambio"
        destructive={targetStatus === "disabled"}
        loading={update.isPending}
        onConfirm={() => update.mutate({ status: targetStatus })}
      />
      <ConfirmDialog
        open={confirmSupport}
        onOpenChange={setConfirmSupport}
        title="Entrar en modo soporte"
        description={`Vas a entrar en ${tenant.name} con acceso de soporte. Se mostrará un aviso visible y la entrada queda registrada en la auditoría.`}
        confirmLabel="Entrar"
        loading={enterSupport.isPending}
        onConfirm={() => enterSupport.mutate()}
      />
    </>
  );
}
