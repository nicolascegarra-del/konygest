"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { can } from "@/lib/auth";
import { friendlyMessage } from "@/lib/errors";
import { useAuthStore } from "@/stores/auth-store";
import type { Role } from "@/types/api";

export function RolesList() {
  const me = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
  const canManage = can(me, "roles.gestionar") && !me?.read_only;
  const [toDelete, setToDelete] = useState<Role | null>(null);

  const query = useQuery({
    queryKey: ["roles"],
    queryFn: ({ signal }) => api.get<Role[]>("/roles", undefined, signal),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/roles/${id}`),
    onSuccess: () => {
      setToDelete(null);
      void queryClient.invalidateQueries({ queryKey: ["roles"] });
      toast.success("Rol eliminado.");
    },
    onError: (error) => {
      setToDelete(null);
      toast.error(friendlyMessage(error));
    },
  });

  return (
    <>
      <PageHeader
        title="Roles y permisos"
        description="Cada rol define qué puede hacer y qué ve en su pantalla inicial."
        actions={
          canManage ? (
            <Button asChild>
              <Link href="/ajustes/roles/nuevo">
                <Plus aria-hidden /> Nuevo rol
              </Link>
            </Button>
          ) : undefined
        }
      />
      {query.isPending ? (
        <LoadingBlock rows={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data.length === 0 ? (
        <EmptyState title="Todavía no hay roles" />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {query.data.map((role) => (
            <li key={role.id}>
              <Card className="h-full">
                <CardHeader>
                  <CardTitle>{role.name}</CardTitle>
                  {role.description ? <CardDescription>{role.description}</CardDescription> : null}
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Users className="size-4" aria-hidden />
                    {role.user_count} {role.user_count === 1 ? "usuario" : "usuarios"} ·{" "}
                    {Object.keys(role.permissions).length} permisos
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/ajustes/roles/${role.id}`}>
                        <Pencil aria-hidden /> {canManage ? "Editar" : "Ver"}
                      </Link>
                    </Button>
                    {canManage ? (
                      <Button variant="outline" size="sm" onClick={() => setToDelete(role)}>
                        <Trash2 aria-hidden /> Eliminar
                      </Button>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title="Eliminar rol"
        description={
          toDelete && toDelete.user_count > 0
            ? `El rol «${toDelete.name}» tiene ${toDelete.user_count} usuarios y no se puede eliminar hasta que se les asigne otro.`
            : `Se eliminará el rol «${toDelete?.name ?? ""}». Esta acción no se puede deshacer.`
        }
        confirmLabel="Eliminar"
        destructive
        loading={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </>
  );
}
