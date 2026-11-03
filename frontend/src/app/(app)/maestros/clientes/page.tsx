import type { Metadata } from "next";

import { MasterPage } from "@/components/masters/master-page";

export const metadata: Metadata = { title: "Clientes" };

export default function CustomersRoutePage() {
  return <MasterPage resource="customers" />;
}
