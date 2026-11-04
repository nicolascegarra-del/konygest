import type { Metadata } from "next";

import { InvoiceDetailView } from "@/components/invoicing/invoice-detail";

export const metadata: Metadata = { title: "Ficha de factura" };

export default async function InvoiceDetailRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoiceDetailView invoiceId={id} />;
}
