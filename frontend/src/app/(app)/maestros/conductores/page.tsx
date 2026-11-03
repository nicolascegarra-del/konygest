import type { Metadata } from "next";

import { MasterPage } from "@/components/masters/master-page";

export const metadata: Metadata = { title: "Conductores" };

export default function DriversRoutePage() {
  return <MasterPage resource="drivers" />;
}
