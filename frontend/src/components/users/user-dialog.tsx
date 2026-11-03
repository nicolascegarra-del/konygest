"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Field } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { emailSchema } from "@/lib/schemas";
import type { Role, UserRow } from "@/types/api";

const userSchema = z.object({
  email: emailSchema,
  full_name: z.string().trim().min(2, "Indica el nombre completo.").max(120),
  role_ids: z.array(z.string()).min(1, "Elige al menos un rol."),
  is_active: z.boolean(),
});
type UserValues = z.infer<typeof userSchema>;

interface UserDialogProps {
  /** null = invitar a un usuario nuevo. */
  user: UserRow | null;
  roles: Role[];
  rolesLoading: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function UserDialog({ user, roles, rolesLoading, onClose, onSaved }: UserDialogProps) {
  const isEdit = user !== null;
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<UserValues>({
    resolver: zodResolver(userSchema),
    defaultValues: {
      email: user?.email ?? "",
      full_name: user?.full_name ?? "",
      role_ids: user?.roles.map((role) => role.id) ?? [],
      is_active: user?.is_active ?? true,
    },
  });

  const save = useMutation({
    mutationFn: (values: UserValues) =>
      user
        ? api.patch(`/users/${user.id}`, {
            full_name: values.full_name,
            role_ids: values.role_ids,
            is_active: values.is_active,
          })
        : api.post("/users", { email: values.email, full_name: values.full_name, role_ids: values.role_ids }),
    onSuccess: () => {
      toast.success(isEdit ? "Usuario actualizado." : "Invitación enviada.");
      onSaved();
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Editar usuario" : "Invitar usuario"}</DialogTitle>
          <DialogDescription>
            {isEdit ? user.email : "Recibirá un email con un enlace para crear su contraseña."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((values) => save.mutate(values))} className="space-y-4" noValidate>
          {!isEdit ? (
            <Field label="Email" htmlFor="user-email" error={errors.email?.message}>
              <Input id="user-email" type="email" autoComplete="off" {...register("email")} />
            </Field>
          ) : null}
          <Field label="Nombre completo" htmlFor="user-name" error={errors.full_name?.message}>
            <Input id="user-name" autoComplete="off" {...register("full_name")} />
          </Field>

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Roles</legend>
            <Controller
              control={control}
              name="role_ids"
              render={({ field }) => (
                <div className="space-y-1">
                  {rolesLoading ? <p className="text-sm text-muted-foreground">Cargando roles…</p> : null}
                  {roles.map((role) => {
                    const checked = field.value.includes(role.id);
                    return (
                      <label key={role.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 hover:bg-accent">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-5 accent-[#2E6DB4]"
                          checked={checked}
                          onChange={() =>
                            field.onChange(checked ? field.value.filter((id) => id !== role.id) : [...field.value, role.id])
                          }
                        />
                        <span className="text-sm">
                          <span className="font-medium">{role.name}</span>
                          {role.description ? (
                            <span className="block text-xs text-muted-foreground">{role.description}</span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            />
            {errors.role_ids ? (
              <p className="mt-1 text-sm text-destructive" role="alert">
                {errors.role_ids.message}
              </p>
            ) : null}
          </fieldset>

          {isEdit ? (
            <Controller
              control={control}
              name="is_active"
              render={({ field }) => (
                <div className="flex min-h-11 items-center gap-3">
                  <Switch id="user-active" checked={field.value} onCheckedChange={field.onChange} />
                  <label htmlFor="user-active" className="text-sm">
                    Usuario activo (puede acceder)
                  </label>
                </div>
              )}
            />
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              {isEdit ? "Guardar" : "Enviar invitación"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
