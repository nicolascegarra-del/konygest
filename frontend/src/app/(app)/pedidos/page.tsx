import type { Metadata } from "next";

import { OrdersPage } from "@/components/orders/orders-page";

export const metadata: Metadata = { title: "Pedidos" };

export default function OrdersRoutePage() {
  return <OrdersPage />;
}
