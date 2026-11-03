import type { Metadata } from "next";

import { MasterPage } from "@/components/masters/master-page";

export const metadata: Metadata = { title: "Tarifas" };

export default function PriceListsRoutePage() {
  return <MasterPage resource="price-lists" />;
}
