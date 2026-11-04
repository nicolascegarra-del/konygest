import type { Metadata } from "next";

import { PlanningBoard } from "@/components/logistics/planning-board";

export const metadata: Metadata = { title: "Planificación" };

export default function PlanningRoutePage() {
  return <PlanningBoard />;
}
