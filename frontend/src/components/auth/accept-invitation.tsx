"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { PasswordForm } from "@/components/auth/password-form";
import { ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { api, apiFetch } from "@/lib/api";
import type { InvitationInfo } from "@/types/api";

export function AcceptInvitation() {
  const router = useRouter();
  const token = useSearchParams().get("token");

  const invitation = useQuery({
    queryKey: ["invitation", token],
    enabled: !!token,
    retry: false,
    queryFn: ({ signal }) =>
      apiFetch<InvitationInfo>("/auth/invitation", { query: { token }, signal, skipRefresh: true }),
  });

  if (!token) {
    return (
      <div className="space-y-4 text-center" role="alert">
        <p className="text-sm">El enlace de invitación no es válido.</p>
        <Button asChild variant="outline" className="w-full">
          <Link href="/login">Ir a acceder</Link>
        </Button>
      </div>
    );
  }
  if (invitation.isPending) return <LoadingBlock rows={3} />;
  if (invitation.isError) return <ErrorState error={invitation.error} />;

  const { tenant_name, full_name, email } = invitation.data;
  return (
    <div className="space-y-5">
      <div className="rounded-md bg-muted p-3 text-sm">
        <p>
          Hola, <strong>{full_name}</strong>. Te han invitado a unirte a <strong>{tenant_name}</strong> en Konygest.
        </p>
        <p className="mt-1 text-muted-foreground">Tu usuario será {email}.</p>
      </div>
      <PasswordForm
        submitLabel="Crear contraseña y continuar"
        onSubmit={async (password) => {
          await api.post("/auth/accept-invite", { token, password }, { skipRefresh: true });
          toast.success("Cuenta activada. Ya puedes acceder.");
          router.replace("/login");
        }}
      />
    </div>
  );
}
