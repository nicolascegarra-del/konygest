import type { Metadata } from "next";

import { PageHeader } from "@/components/common/states";
import { AuditLog } from "@/components/settings/audit-log";

export const metadata: Metadata = { title: "Actividad" };

export default function ActivityPage() {
  return (
    <>
      <PageHeader title="Actividad" description="Quién hizo qué y cuándo en tu empresa." />
      <AuditLog />
    </>
  );
}
