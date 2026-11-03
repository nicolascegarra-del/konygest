import type { Metadata } from "next";

import { PreferencesEditor } from "@/components/account/preferences-editor";
import { PageHeader } from "@/components/common/states";

export const metadata: Metadata = { title: "Avisos de la empresa" };

export default function TenantNotificationsPage() {
  return (
    <>
      <PageHeader
        title="Avisos de la empresa"
        description="Canales permitidos para cada tipo de aviso. Cada usuario podrá ajustar los suyos dentro de estos límites."
      />
      <PreferencesEditor endpoint="/notifications/tenant-settings" queryKey={["notifications", "tenant-settings"]} />
    </>
  );
}
