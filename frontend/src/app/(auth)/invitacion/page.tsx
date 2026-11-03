import type { Metadata } from "next";
import { Suspense } from "react";

import { AcceptInvitation } from "@/components/auth/accept-invitation";
import { AuthShell } from "@/components/auth/auth-shell";

export const metadata: Metadata = { title: "Aceptar invitación", robots: { index: false } };

export default function InvitationPage() {
  return (
    <AuthShell title="Crea tu contraseña">
      <Suspense>
        <AcceptInvitation />
      </Suspense>
    </AuthShell>
  );
}
