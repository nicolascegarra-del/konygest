import type { Metadata } from "next";

import { PreferencesEditor } from "@/components/account/preferences-editor";
import { PushCard } from "@/components/account/push-card";
import { PageHeader } from "@/components/common/states";

export const metadata: Metadata = { title: "Mis avisos" };

export default function MyNotificationsPage() {
  return (
    <>
      <PageHeader title="Mis avisos" description="Elige cómo quieres recibir cada tipo de aviso, dentro de lo que permita tu empresa." />
      <div className="space-y-6">
        <PushCard />
        <PreferencesEditor endpoint="/notifications/preferences" queryKey={["notifications", "preferences"]} />
      </div>
    </>
  );
}
