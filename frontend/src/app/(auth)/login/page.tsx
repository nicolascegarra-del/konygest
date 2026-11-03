import type { Metadata } from "next";

import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Acceder", robots: { index: false } };

export default function LoginPage() {
  return (
    <AuthShell title="Acceder a Konygest" description="Introduce tus credenciales para continuar.">
      <LoginForm />
    </AuthShell>
  );
}
