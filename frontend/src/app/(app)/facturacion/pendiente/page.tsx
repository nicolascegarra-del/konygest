import type { Metadata } from "next";

import { PendingInvoicingPage } from "@/components/invoicing/pending-page";

export const metadata: Metadata = { title: "Pendiente de facturar" };

export default function PendingInvoicingRoutePage() {
  return <PendingInvoicingPage />;
}
