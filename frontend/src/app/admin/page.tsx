import type { Metadata } from "next";

import { PageHeader } from "@/components/common/states";
import { StatsView } from "@/components/admin/stats-view";

export const metadata: Metadata = { title: "Resumen · Panel de Klyp" };

export default function AdminHomePage() {
  return (
    <>
      <PageHeader title="Resumen" description="Estado global de la plataforma." />
      <StatsView />
    </>
  );
}
