import type { Metadata } from "next";

import { WeighingListPage } from "@/components/logistics/weighing";

export const metadata: Metadata = { title: "Cargas por pesar" };

export default function WeighingListRoutePage() {
  return <WeighingListPage />;
}
