import type { Metadata } from "next";

import { PageHeader } from "@/components/common/states";
import { EmailConfigForm } from "@/components/settings/email-config-form";

export const metadata: Metadata = { title: "Correo global · Panel de Klyp" };

export default function AdminEmailPage() {
  return (
    <>
      <PageHeader title="Correo global" description="Servidor SMTP de la plataforma para invitaciones, recuperaciones y avisos." />
      <EmailConfigForm
        endpoint="/admin/email-config"
        title="Servidor SMTP de la plataforma"
        description="Lo usan todas las empresas que no tengan el suyo propio."
      />
    </>
  );
}
