import type { Metadata } from "next";

import { PageHeader } from "@/components/common/states";
import { EmailConfigForm } from "@/components/settings/email-config-form";

export const metadata: Metadata = { title: "Correo saliente" };

export default function TenantEmailPage() {
  return (
    <>
      <PageHeader title="Correo saliente" description="Desde qué servidor se envían las invitaciones y los avisos de tu empresa." />
      <EmailConfigForm
        endpoint="/tenant/email-config"
        title="Servidor SMTP propio"
        description="Opcional. Si no lo configuras, se usa el servidor de la plataforma."
        canReset
      />
    </>
  );
}
