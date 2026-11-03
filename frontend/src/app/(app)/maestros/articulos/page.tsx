import type { Metadata } from "next";

import { MasterPage } from "@/components/masters/master-page";

export const metadata: Metadata = { title: "Artículos" };

export default function ItemsRoutePage() {
  return <MasterPage resource="items" />;
}
