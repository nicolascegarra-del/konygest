"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { PasswordForm } from "@/components/auth/password-form";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export function ResetPassword() {
  const router = useRouter();
  const token = useSearchParams().get("token");

  if (!token) {
    return (
      <div className="space-y-4 text-center" role="alert">
        <p className="text-sm">El enlace no es válido. Solicita uno nuevo.</p>
        <Button asChild className="w-full">
          <Link href="/recuperar">Solicitar otro enlace</Link>
        </Button>
      </div>
    );
  }

  return (
    <PasswordForm
      submitLabel="Cambiar contraseña"
      onSubmit={async (password) => {
        await api.post("/auth/reset-password", { token, password }, { skipRefresh: true });
        toast.success("Contraseña cambiada. Ya puedes acceder.");
        router.replace("/login");
      }}
    />
  );
}
