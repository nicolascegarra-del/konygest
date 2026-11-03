import type { Metadata } from "next";
import type { ReactNode } from "react";

import { PlatformFrame } from "@/components/app/tenant-frame";

export const metadata: Metadata = { title: "Panel de Klyp", robots: { index: false, follow: false } };

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <PlatformFrame>{children}</PlatformFrame>;
}
