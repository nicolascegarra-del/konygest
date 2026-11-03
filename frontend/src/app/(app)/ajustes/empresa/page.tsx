import type { Metadata } from "next";

import { PageHeader } from "@/components/common/states";
import { CompanySettings } from "@/components/settings/company-settings";

export const metadata: Metadata = { title: "Empresa" };

export default function CompanyPage() {
  return (
    <>
      <PageHeader title="Empresa" description="Datos, seguridad y módulos de tu empresa." />
      <CompanySettings />
    </>
  );
}
