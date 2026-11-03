"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FormError } from "@/components/auth/auth-shell";
import { Field } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionBootstrap } from "@/hooks/use-session";
import { homePathFor, login } from "@/lib/auth";
import { friendlyMessage, isApiError } from "@/lib/errors";
import { emailSchema, totpCodeSchema } from "@/lib/schemas";
import { useAuthStore } from "@/stores/auth-store";

const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Introduce tu contraseña."),
});
const codeSchema = z.object({ code: totpCodeSchema });

type CredentialsValues = z.infer<typeof credentialsSchema>;
type CodeValues = z.infer<typeof codeSchema>;

export function LoginForm() {
  const router = useRouter();
  const status = useSessionBootstrap();
  const user = useAuthStore((state) => state.user);
  const [credentials, setCredentials] = useState<CredentialsValues | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Si ya hay sesión (cookie de refresh válida), saltarse el login.
  useEffect(() => {
    if (status === "authenticated" && user) router.replace(homePathFor(user));
  }, [status, user, router]);

  const credentialsForm = useForm<CredentialsValues>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { email: "", password: "" },
  });
  const codeForm = useForm<CodeValues>({ resolver: zodResolver(codeSchema), defaultValues: { code: "" } });

  async function submit(values: CredentialsValues, totpCode?: string): Promise<void> {
    setFormError(null);
    try {
      const me = await login({ email: values.email, password: values.password, totpCode });
      router.replace(homePathFor(me));
    } catch (error) {
      if (isApiError(error, "TOTP_REQUIRED")) {
        setCredentials(values);
        setNeedsCode(true);
        return;
      }
      if (needsCode && isApiError(error, "TOTP_INVALID")) codeForm.reset({ code: "" });
      setFormError(friendlyMessage(error));
    }
  }

  if (needsCode && credentials) {
    return (
      <form onSubmit={codeForm.handleSubmit((values) => submit(credentials, values.code))} className="space-y-4" noValidate>
        <p className="text-sm text-muted-foreground">
          Abre tu aplicación de autenticación e introduce el código de 6 dígitos de Konygest.
        </p>
        <FormError message={formError} />
        <Field label="Código de verificación" htmlFor="code" error={codeForm.formState.errors.code?.message}>
          <Input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            className="text-center text-lg tracking-[0.4em]"
            {...codeForm.register("code")}
          />
        </Field>
        <Button type="submit" className="w-full" loading={codeForm.formState.isSubmitting}>
          Verificar y entrar
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => {
            setNeedsCode(false);
            setFormError(null);
          }}
        >
          Volver
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={credentialsForm.handleSubmit((values) => submit(values))} className="space-y-4" noValidate>
      <FormError message={formError} />
      <Field label="Email" htmlFor="email" error={credentialsForm.formState.errors.email?.message}>
        <Input id="email" type="email" autoComplete="username" autoFocus {...credentialsForm.register("email")} />
      </Field>
      <Field label="Contraseña" htmlFor="password" error={credentialsForm.formState.errors.password?.message}>
        <Input id="password" type="password" autoComplete="current-password" {...credentialsForm.register("password")} />
      </Field>
      <Button type="submit" className="w-full" loading={credentialsForm.formState.isSubmitting}>
        Entrar
      </Button>
      <p className="text-center text-sm">
        <Link href="/recuperar" className="inline-flex min-h-11 items-center text-link hover:underline">
          ¿Has olvidado tu contraseña?
        </Link>
      </p>
    </form>
  );
}
