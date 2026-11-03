"use client";

import { useRouter, usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { LoadingBlock } from "@/components/common/states";
import { useSessionBootstrap } from "@/hooks/use-session";
import { setAuthHooks } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";

type GateMode = "tenant" | "platform";

/**
 * Protege un grupo de rutas: sin sesión lleva a /login; exige activar el 2FA si la empresa
 * lo pide; y separa la zona de empresa de la del panel de Klyp.
 */
export function AuthGate({ mode, children }: { mode: GateMode; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const status = useSessionBootstrap();
  const user = useAuthStore((state) => state.user);

  useEffect(() => {
    setAuthHooks({
      onSessionExpired: () => router.replace("/login"),
      onTwoFactorSetupRequired: () => router.replace("/cuenta/seguridad"),
    });
  }, [router]);

  const isAccountRoute = pathname.startsWith("/cuenta");
  let redirectTo: string | null = null;
  if (status === "anonymous") {
    redirectTo = "/login";
  } else if (status === "authenticated" && user) {
    if (user.must_setup_2fa && !pathname.startsWith("/cuenta/seguridad")) {
      redirectTo = "/cuenta/seguridad";
    } else if (mode === "platform" && !user.platform_role) {
      redirectTo = "/inicio";
    } else if (mode === "tenant" && !user.tenant && user.platform_role && !isAccountRoute) {
      // Personal de Klyp fuera de una empresa: su sitio es el panel.
      redirectTo = "/admin";
    }
  }

  useEffect(() => {
    if (redirectTo) router.replace(redirectTo);
  }, [redirectTo, router]);

  if (status !== "authenticated" || !user || redirectTo) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md items-center justify-center p-6">
        <LoadingBlock rows={3} className="w-full" />
      </div>
    );
  }
  return <>{children}</>;
}
