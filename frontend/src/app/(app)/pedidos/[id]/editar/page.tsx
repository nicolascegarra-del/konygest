import type { Metadata } from "next";

import { EditOrderPage } from "@/components/orders/order-form-pages";

export const metadata: Metadata = { title: "Editar pedido" };

export default async function EditOrderRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditOrderPage orderId={id} />;
}
