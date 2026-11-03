import type { Metadata } from "next";

import { OrderDetail } from "@/components/orders/order-detail";

export const metadata: Metadata = { title: "Ficha de pedido" };

export default async function OrderDetailRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderDetail orderId={id} />;
}
