import type { Metadata } from "next";

import { NewOrderPage } from "@/components/orders/order-form-pages";

export const metadata: Metadata = { title: "Nuevo pedido" };

export default function NewOrderRoutePage() {
  return <NewOrderPage />;
}
