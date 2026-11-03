"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailPlus, Pencil, Search, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataList, type DataColumn } from "@/components/common/data-list";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from "@/components/common/states";
import { UserDialog } from "@/components/users/user-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api } from "@/lib/api";
import { can } from "@/lib/auth";
import { friendlyMessage } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { useAuthStore } from "@/stores/auth-store";
import type { Page, Role, UserRow } from "@/types/api";

const PAGE_SIZE = 25;

export function UsersPage() {
  const me = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
  const canManage = can(me, "usuarios.gestionar") && !me?.read_only;

  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [dialogUser, setDialogUser] = useState<UserRow | "new" | null>(null);
  const debouncedSearch = useDebouncedValue(search.trim());

  const users = useQuery({
    queryKey: ["users", debouncedSearch, offset],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<Page<UserRow>>("/users", { search: debouncedSearch, offset, limit: PAGE_SIZE }, signal),
  });
  const roles = useQuery({
    queryKey: ["roles"],
    queryFn: ({ signal }) => api.get<Role[]>("/roles", undefined, signal),
  });

  const resend = useMutation({
    mutationFn: (id: string) => api.post(`/users/${id}/resend-invite`),
    onSuccess: () => toast.success("Invitación reenviada."),
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  const columns: DataColumn<UserRow>[] = [
    {
      key: "name",
      header: "Usuario",
      render: (user) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{user.full_name}</p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
        </div>
      ),
    },
    {
      key: "roles",
      header: "Roles",
      render: (user) =>
        user.roles.length === 0 ? (
          "—"
        ) : (
          <span className="flex flex-wrap justify-end gap-1 md:justify-start">
            {user.roles.map((role) => (
              <Badge key={role.id} variant="secondary">
                {role.name}
              </Badge>
            ))}
          </span>
        ),
    },
    {
      key: "status",
      header: "Estado",
      render: (user) =>
        user.pending_invite ? (
          <Badge variant="warning">Invitación pendiente</Badge>
        ) : user.is_active ? (
          <Badge variant="success">Activo</Badge>
        ) : (
          <Badge variant="destructive">Desactivado</Badge>
        ),
    },
    { key: "last", header: "Último acceso", render: (user) => formatDate(user.last_login_at) },
    ...(canManage
      ? [
          {
            key: "actions",
            header: "Acciones",
            isActions: true,
            render: (user: UserRow) => (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setDialogUser(user)}>
                  <Pencil aria-hidden /> Editar
                </Button>
                {user.pending_invite ? (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={resend.isPending && resend.variables === user.id}
                    onClick={() => resend.mutate(user.id)}
                  >
                    <MailPlus aria-hidden /> Reenviar invitación
                  </Button>
                ) : null}
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Usuarios"
        description="Personas con acceso a tu empresa y sus roles."
        actions={
          canManage ? (
            <Button onClick={() => setDialogUser("new")}>
              <UserPlus aria-hidden /> Invitar usuario
            </Button>
          ) : undefined
        }
      />

      <div className="relative mb-4 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
          placeholder="Buscar por nombre o email"
          aria-label="Buscar usuarios"
          className="pl-9"
        />
      </div>

      {users.isPending ? (
        <LoadingBlock rows={5} />
      ) : users.isError ? (
        <ErrorState error={users.error} onRetry={() => users.refetch()} />
      ) : users.data.items.length === 0 ? (
        <EmptyState
          title={debouncedSearch ? "Ningún usuario coincide con la búsqueda" : "Todavía no hay usuarios"}
          description={debouncedSearch ? undefined : "Invita a tu equipo para que pueda acceder."}
        />
      ) : (
        <>
          <DataList rows={users.data.items} columns={columns} rowKey={(user) => user.id} />
          <Pagination offset={offset} limit={PAGE_SIZE} total={users.data.total} onChange={setOffset} />
        </>
      )}

      {dialogUser !== null ? (
        <UserDialog
          user={dialogUser === "new" ? null : dialogUser}
          roles={roles.data ?? []}
          rolesLoading={roles.isPending}
          onClose={() => setDialogUser(null)}
          onSaved={() => {
            setDialogUser(null);
            void queryClient.invalidateQueries({ queryKey: ["users"] });
            void queryClient.invalidateQueries({ queryKey: ["roles"] });
          }}
        />
      ) : null}
    </>
  );
}
