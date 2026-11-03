import type { Metadata } from "next";

import { MasterPage } from "@/components/masters/master-page";

export const metadata: Metadata = { title: "Silos y almacenes" };

export default function SilosRoutePage() {
  return <MasterPage resource="silos" />;
}
