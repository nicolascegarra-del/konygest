import type { Metadata } from "next";

import { ReceiptsPage } from "@/components/factory/receipts-page";

export const metadata: Metadata = { title: "Entradas de materia prima" };

export default function ReceiptsPageRoute() {
  return <ReceiptsPage />;
}
