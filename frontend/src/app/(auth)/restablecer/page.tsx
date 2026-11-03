import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { ResetPassword } from "@/components/auth/reset-password";

export const metadata: Metadata = { title: "Restablecer contraseña", robots: { index: false } };

export default function ResetPage() {
  return (
    <AuthShell title="Nueva contraseña" description="Elige una contraseña nueva para tu cuenta.">
      <Suspense>
        <ResetPassword />
      </Suspense>
    </AuthShell>
  );
}
