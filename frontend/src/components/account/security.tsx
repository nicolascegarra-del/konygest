"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Field } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { homePathFor, reloadMe } from "@/lib/auth";
import { friendlyMessage } from "@/lib/errors";
import { totpCodeSchema } from "@/lib/schemas";
import { useAuthStore } from "@/stores/auth-store";
import type { Me, TwoFactorSetup } from "@/types/api";

const enableSchema = z.object({ code: totpCodeSchema });
type EnableValues = z.infer<typeof enableSchema>;

function EnableTwoFactor({ mustSetup }: { mustSetup: boolean }) {
  const router = useRouter();
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<EnableValues>({ resolver: zodResolver(enableSchema), defaultValues: { code: "" } });

  const start = useMutation({
    mutationFn: () => api.post<TwoFactorSetup>("/auth/2fa/setup"),
    onSuccess: setSetup,
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  const enable = useMutation({
    mutationFn: (values: EnableValues) => api.post("/auth/2fa/enable", values),
    onSuccess: async () => {
      const me = await reloadMe();
      setSetup(null);
      toast.success("Verificación en dos pasos activada.");
      if (mustSetup) router.replace(homePathFor(me));
    },
    onError: (error) => {
      reset({ code: "" });
      toast.error(friendlyMessage(error));
    },
  });

  if (!setup) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          Protege tu cuenta con un código de una aplicación de autenticación (Google Authenticator, Microsoft
          Authenticator, Authy...).
        </p>
        <Button loading={start.isPending} onClick={() => start.mutate()}>
          <ShieldCheck aria-hidden /> Activar verificación en dos pasos
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Escanea el código QR con tu aplicación de autenticación.</li>
        <li>Introduce el código de 6 dígitos que te muestra para confirmar.</li>
      </ol>
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <div className="rounded-lg bg-white p-3" aria-label="Código QR para la aplicación de autenticación" role="img">
          <QRCodeSVG value={setup.otpauth_uri} size={176} level="M" />
        </div>
        <div className="min-w-0 text-sm">
          <p className="text-muted-foreground">¿No puedes escanear? Introduce esta clave a mano:</p>
          <code className="mt-1 block break-all rounded bg-muted px-2 py-1 font-mono text-xs">{setup.secret}</code>
        </div>
      </div>
      <form onSubmit={handleSubmit((values) => enable.mutate(values))} className="max-w-xs space-y-3" noValidate>
        <Field label="Código de verificación" htmlFor="enable-code" error={errors.code?.message}>
          <Input id="enable-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} {...register("code")} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" loading={enable.isPending}>
            Confirmar y activar
          </Button>
          <Button type="button" variant="outline" onClick={() => setSetup(null)}>
            Cancelar
          </Button>
        </div>
      </form>
    </div>
  );
}

const disableSchema = z.object({
  password: z.string().min(1, "Introduce tu contraseña."),
  code: totpCodeSchema,
});
type DisableValues = z.infer<typeof disableSchema>;

function DisableTwoFactor() {
  const [open, setOpen] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<DisableValues>({ resolver: zodResolver(disableSchema), defaultValues: { password: "", code: "" } });

  const disable = useMutation({
    mutationFn: (values: DisableValues) => api.post("/auth/2fa/disable", values),
    onSuccess: async () => {
      await reloadMe();
      reset();
      setOpen(false);
      toast.success("Verificación en dos pasos desactivada.");
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        Desactivar
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit((values) => disable.mutate(values))} className="max-w-xs space-y-3" noValidate>
      <Field label="Contraseña" htmlFor="disable-password" error={errors.password?.message}>
        <Input id="disable-password" type="password" autoComplete="current-password" {...register("password")} />
      </Field>
      <Field label="Código de verificación" htmlFor="disable-code" error={errors.code?.message}>
        <Input id="disable-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} {...register("code")} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="destructive" loading={disable.isPending}>
          Desactivar verificación
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function LogoutAll() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);

  const logoutAll = useMutation({
    mutationFn: () => api.post("/auth/logout-all"),
    onSuccess: () => {
      useAuthStore.getState().clear();
      queryClient.clear();
      router.replace("/login");
    },
    onError: (error) => {
      setConfirm(false);
      toast.error(friendlyMessage(error));
    },
  });

  return (
    <>
      <Button variant="outline" onClick={() => setConfirm(true)}>
        Cerrar todas mis sesiones
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Cerrar todas las sesiones"
        description="Se cerrará tu sesión en todos los dispositivos, incluido este. Tendrás que volver a acceder."
        confirmLabel="Cerrar sesiones"
        destructive
        loading={logoutAll.isPending}
        onConfirm={() => logoutAll.mutate()}
      />
    </>
  );
}

export function SecurityPanel({ me }: { me: Me }) {
  return (
    <div className="space-y-6">
      {me.must_setup_2fa ? (
        <div className="flex items-start gap-3 rounded-lg border border-warning/50 bg-warning/10 p-4 text-sm" role="alert">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
          <p>
            {me.platform_role
              ? "El equipo de Klyp debe usar la verificación en dos pasos. Actívala para entrar en el panel."
              : "Tu empresa exige la verificación en dos pasos. Actívala para poder seguir usando Konygest."}
          </p>
        </div>
      ) : null}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Verificación en dos pasos</CardTitle>
            <Badge variant={me.totp_enabled ? "success" : "secondary"}>{me.totp_enabled ? "Activada" : "Desactivada"}</Badge>
          </div>
          <CardDescription>Añade una capa extra de seguridad al iniciar sesión.</CardDescription>
        </CardHeader>
        <CardContent>
          {me.totp_enabled ? (
            <DisableTwoFactor />
          ) : (
            <EnableTwoFactor mustSetup={me.must_setup_2fa} />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Sesiones</CardTitle>
          <CardDescription>Si crees que alguien más ha usado tu cuenta, cierra todas las sesiones abiertas.</CardDescription>
        </CardHeader>
        <CardContent>
          <LogoutAll />
        </CardContent>
      </Card>
    </div>
  );
}
