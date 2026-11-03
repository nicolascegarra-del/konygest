"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ErrorState, Field, LoadingBlock, PageHeader } from "@/components/common/states";
import { LayoutEditor } from "@/components/dashboard/layout-editor";
import { PermissionMatrix } from "@/components/roles/permission-matrix";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { api } from "@/lib/api";
import { can } from "@/lib/auth";
import { ApiError, friendlyMessage } from "@/lib/errors";
import { useAuthStore } from "@/stores/auth-store";
import type { DashboardResponse, PermissionDef, Role, RolePayload, Scope, WidgetItem } from "@/types/api";

const detailsSchema = z.object({
  name: z.string().trim().min(2, "Indica el nombre del rol.").max(60),
  description: z.string().trim().max(250),
});
type DetailsValues = z.infer<typeof detailsSchema>;

/** Editor de un rol (nuevo si `roleId` es null): datos, matriz de permisos y pantalla inicial. */
export function RoleEditor({ roleId }: { roleId: string | null }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useAuthStore((state) => state.user);

  const roles = useQuery({
    queryKey: ["roles"],
    queryFn: ({ signal }) => api.get<Role[]>("/roles", undefined, signal),
  });
  const permissions = useQuery({
    queryKey: ["permissions"],
    queryFn: ({ signal }) => api.get<PermissionDef[]>("/permissions", undefined, signal),
  });
  const dashboard = useQuery({
    queryKey: ["me", "dashboard"],
    queryFn: ({ signal }) => api.get<DashboardResponse>("/me/dashboard", undefined, signal),
  });

  const failed = roles.error ?? permissions.error ?? dashboard.error;
  if (failed) {
    return (
      <ErrorState
        error={failed}
        onRetry={() => {
          void roles.refetch();
          void permissions.refetch();
          void dashboard.refetch();
        }}
      />
    );
  }
  if (!roles.data || !permissions.data || !dashboard.data) return <LoadingBlock rows={5} />;

  const role = roleId ? (roles.data.find((candidate) => candidate.id === roleId) ?? null) : null;
  if (roleId && !role) {
    return (
      <ErrorState error={new ApiError({ status: 404, code: "NOT_FOUND", message: "No se ha encontrado el rol." })} />
    );
  }

  const canManage = can(me, "roles.gestionar") && !me?.read_only;
  const canEditHome = can(me, "inicio.configurar_roles") && !me?.read_only;

  return (
    <RoleEditorForm
      key={role?.id ?? "new"}
      role={role}
      permissions={permissions.data}
      catalog={dashboard.data.catalog}
      canManage={canManage}
      canEditHome={canEditHome}
      onSaved={() => {
        void queryClient.invalidateQueries({ queryKey: ["roles"] });
        router.push("/ajustes/roles");
      }}
    />
  );
}

interface RoleEditorFormProps {
  role: Role | null;
  permissions: PermissionDef[];
  catalog: DashboardResponse["catalog"];
  canManage: boolean;
  canEditHome: boolean;
  onSaved: () => void;
}

function RoleEditorForm({ role, permissions, catalog, canManage, canEditHome, onSaved }: RoleEditorFormProps) {
  const [grants, setGrants] = useState<Record<string, Scope>>(role?.permissions ?? {});
  const [layout, setLayout] = useState<WidgetItem[]>(role?.dashboard_layout ?? []);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<DetailsValues>({
    resolver: zodResolver(detailsSchema),
    defaultValues: { name: role?.name ?? "", description: role?.description ?? "" },
  });

  const save = useMutation({
    mutationFn: (details: DetailsValues) => {
      const payload: RolePayload = {
        name: details.name,
        description: details.description,
        permissions: grants,
        dashboard_layout: layout,
      };
      return role ? api.patch<Role>(`/roles/${role.id}`, payload) : api.post<Role>("/roles", payload);
    },
    onSuccess: () => {
      toast.success(role ? "Rol actualizado." : "Rol creado.");
      onSaved();
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  return (
    <form onSubmit={handleSubmit((details) => save.mutate(details))} noValidate>
      <PageHeader
        title={role ? `Rol: ${role.name}` : "Nuevo rol"}
        description="Define qué puede hacer y qué ve en su pantalla inicial quien tenga este rol."
        actions={
          canManage || canEditHome ? (
            <Button type="submit" loading={save.isPending}>
              Guardar rol
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Datos</CardTitle>
          </CardHeader>
          <CardContent className="max-w-lg space-y-4">
            <Field label="Nombre" htmlFor="role-name" error={errors.name?.message}>
              <Input id="role-name" disabled={!canManage} {...register("name")} />
            </Field>
            <Field label="Descripción" htmlFor="role-description" error={errors.description?.message}>
              <Textarea id="role-description" disabled={!canManage} {...register("description")} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Permisos</CardTitle>
            <CardDescription>
              Marca lo que puede hacer. Los permisos de módulos que la empresa no tiene activos no se pueden conceder.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PermissionMatrix permissions={permissions} value={grants} onChange={setGrants} disabled={!canManage} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pantalla inicial por defecto</CardTitle>
            <CardDescription>
              Es lo que verá cada persona con este rol, hasta que personalice la suya. El catálogo muestra los widgets
              que tú tienes disponibles.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canEditHome ? (
              <LayoutEditor layout={layout} catalog={catalog} onChange={setLayout} />
            ) : (
              <p className="text-sm text-muted-foreground">No tienes permiso para cambiar la pantalla inicial de los roles.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </form>
  );
}
