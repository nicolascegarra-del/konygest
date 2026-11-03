import type { Metadata } from "next";

import { MasterPage } from "@/components/masters/master-page";

export const metadata: Metadata = { title: "Tipos de IVA" };

export default function VatRatesRoutePage() {
  return <MasterPage resource="vat-rates" />;
}
