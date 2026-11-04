import type { Metadata } from "next";

import { InvoicesPage } from "@/components/invoicing/invoices-page";

export const metadata: Metadata = { title: "Facturas" };

export default function InvoicesRoutePage() {
  return <InvoicesPage />;
}
