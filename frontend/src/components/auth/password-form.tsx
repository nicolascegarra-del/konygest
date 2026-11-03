"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { FormError } from "@/components/auth/auth-shell";
import { Field } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { friendlyMessage } from "@/lib/errors";
import { newPasswordSchema, PASSWORD_MIN_LENGTH, type NewPasswordValues } from "@/lib/schemas";

/** Formulario de nueva contraseña con confirmación, reutilizado en restablecer e invitación. */
export function PasswordForm({
  submitLabel,
  onSubmit,
}: {
  submitLabel: string;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<NewPasswordValues>({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: { password: "", confirm: "" },
  });

  async function submit(values: NewPasswordValues): Promise<void> {
    setFormError(null);
    try {
      await onSubmit(values.password);
    } catch (error) {
      setFormError(friendlyMessage(error));
    }
  }

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
      <FormError message={formError} />
      <Field
        label="Contraseña nueva"
        htmlFor="password"
        error={errors.password?.message}
        hint={`Mínimo ${PASSWORD_MIN_LENGTH} caracteres.`}
      >
        <Input id="password" type="password" autoComplete="new-password" autoFocus {...register("password")} />
      </Field>
      <Field label="Repite la contraseña" htmlFor="confirm" error={errors.confirm?.message}>
        <Input id="confirm" type="password" autoComplete="new-password" {...register("confirm")} />
      </Field>
      <Button type="submit" className="w-full" loading={isSubmitting}>
        {submitLabel}
      </Button>
    </form>
  );
}
