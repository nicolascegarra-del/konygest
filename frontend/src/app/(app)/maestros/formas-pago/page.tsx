import type { Metadata } from "next";

import { MasterPage } from "@/components/masters/master-page";

export const metadata: Metadata = { title: "Formas de pago" };

export default function PaymentMethodsRoutePage() {
  return <MasterPage resource="payment-methods" />;
}
