import type { Metadata } from "next";

import { CustomerDetail } from "@/components/masters/customer-detail";

export const metadata: Metadata = { title: "Ficha de cliente" };

export default async function CustomerDetailRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CustomerDetail customerId={id} />;
}
