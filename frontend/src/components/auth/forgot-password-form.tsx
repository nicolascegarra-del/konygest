"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { MailCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FormError } from "@/components/auth/auth-shell";
import { Field } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { emailSchema } from "@/lib/schemas";

const schema = z.object({ email: emailSchema });
type Values = z.infer<typeof schema>;

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "" } });

  async function onSubmit(values: Values): Promise<void> {
    setFormError(null);
    try {
      await api.post("/auth/forgot-password", values, { skipRefresh: true });
      setSent(true);
    } catch (error) {
      setFormError(friendlyMessage(error));
    }
  }

  if (sent) {
    return (
      <div className="space-y-4 text-center" role="status">
        <MailCheck className="mx-auto size-10 text-primary" aria-hidden />
        <p className="text-sm">
          Si el email está registrado, recibirás en unos minutos un enlace para restablecer tu contraseña.
        </p>
        <Button asChild variant="outline" className="w-full">
          <Link href="/login">Volver a acceder</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <FormError message={formError} />
      <Field label="Email" htmlFor="email" error={errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" autoFocus {...register("email")} />
      </Field>
      <Button type="submit" className="w-full" loading={isSubmitting}>
        Enviar enlace
      </Button>
      <p className="text-center text-sm">
        <Link href="/login" className="inline-flex min-h-11 items-center text-link hover:underline">
          Volver a acceder
        </Link>
      </p>
    </form>
  );
}
