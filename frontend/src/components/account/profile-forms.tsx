"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Field } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { newPasswordSchema, PASSWORD_MIN_LENGTH } from "@/lib/schemas";
import { useAuthStore } from "@/stores/auth-store";
import type { Me } from "@/types/api";

const profileSchema = z.object({ full_name: z.string().trim().min(2, "Indica tu nombre.").max(120) });
type ProfileValues = z.infer<typeof profileSchema>;

export function ProfileForm({ me }: { me: Me }) {
  const setUser = useAuthStore((state) => state.setUser);
  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm<ProfileValues>({ resolver: zodResolver(profileSchema), defaultValues: { full_name: me.full_name } });

  const update = useMutation({
    mutationFn: (values: ProfileValues) => api.patch<Me>("/me", values),
    onSuccess: (updated) => {
      setUser(updated);
      toast.success("Perfil actualizado.");
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Perfil</CardTitle>
        <CardDescription>Tus datos de contacto dentro de Konygest.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit((values) => update.mutate(values))} className="max-w-md space-y-4" noValidate>
          <Field label="Email" htmlFor="email" hint="El email no se puede cambiar desde aquí.">
            <Input id="email" value={me.email} readOnly disabled />
          </Field>
          <Field label="Nombre completo" htmlFor="full_name" error={errors.full_name?.message}>
            <Input id="full_name" autoComplete="name" {...register("full_name")} />
          </Field>
          <Button type="submit" disabled={!isDirty} loading={update.isPending}>
            Guardar cambios
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

const changePasswordSchema = z
  .object({ current_password: z.string().min(1, "Introduce tu contraseña actual.") })
  .and(newPasswordSchema);
type ChangePasswordValues = z.infer<typeof changePasswordSchema>;

export function ChangePasswordForm() {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { current_password: "", password: "", confirm: "" },
  });

  const change = useMutation({
    mutationFn: (values: ChangePasswordValues) =>
      api.post("/me/password", { current_password: values.current_password, new_password: values.password }),
    onSuccess: () => {
      reset();
      toast.success("Contraseña cambiada.");
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cambiar contraseña</CardTitle>
        <CardDescription>Mínimo {PASSWORD_MIN_LENGTH} caracteres.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit((values) => change.mutate(values))} className="max-w-md space-y-4" noValidate>
          <Field label="Contraseña actual" htmlFor="current_password" error={errors.current_password?.message}>
            <Input id="current_password" type="password" autoComplete="current-password" {...register("current_password")} />
          </Field>
          <Field label="Contraseña nueva" htmlFor="password" error={errors.password?.message}>
            <Input id="password" type="password" autoComplete="new-password" {...register("password")} />
          </Field>
          <Field label="Repite la contraseña nueva" htmlFor="confirm" error={errors.confirm?.message}>
            <Input id="confirm" type="password" autoComplete="new-password" {...register("confirm")} />
          </Field>
          <Button type="submit" loading={change.isPending}>
            Cambiar contraseña
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
