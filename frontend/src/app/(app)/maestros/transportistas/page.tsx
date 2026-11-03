import type { Metadata } from "next";

import { MasterPage } from "@/components/masters/master-page";

export const metadata: Metadata = { title: "Transportistas" };

export default function CarriersRoutePage() {
  return <MasterPage resource="carriers" />;
}
