import type { Metadata } from "next";

import { ValidationInbox } from "@/components/orders/validation-inbox";

export const metadata: Metadata = { title: "Pedidos por validar" };

export default function ValidationInboxRoutePage() {
  return <ValidationInbox />;
}
