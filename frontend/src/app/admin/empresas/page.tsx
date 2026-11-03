import type { Metadata } from "next";

import { TenantsPage } from "@/components/admin/tenants-page";

export const metadata: Metadata = { title: "Empresas · Panel de Klyp" };

export default function AdminTenantsPage() {
  return <TenantsPage />;
}
