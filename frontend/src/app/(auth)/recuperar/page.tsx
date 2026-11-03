import type { Metadata } from "next";

import { AuthShell } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export const metadata: Metadata = { title: "Recuperar contraseña", robots: { index: false } };

export default function RecoverPage() {
  return (
    <AuthShell title="Recuperar contraseña" description="Te enviaremos un enlace para crear una contraseña nueva.">
      <ForgotPasswordForm />
    </AuthShell>
  );
}
