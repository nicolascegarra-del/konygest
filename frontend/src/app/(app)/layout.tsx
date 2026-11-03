import type { Metadata } from "next";
import type { ReactNode } from "react";

import { TenantFrame } from "@/components/app/tenant-frame";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AppLayout({ children }: { children: ReactNode }) {
  return <TenantFrame>{children}</TenantFrame>;
}
