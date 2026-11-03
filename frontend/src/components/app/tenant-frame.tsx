"use client";

import type { ReactNode } from "react";

import { AppFrame } from "@/components/app/app-frame";
import { AuthGate } from "@/components/app/auth-gate";
import { buildPlatformNav, buildTenantNav } from "@/lib/navigation";
import { useAuthStore } from "@/stores/auth-store";

/** Layout de la zona de empresa. El personal de Klyp sin empresa ve el menú del panel. */
export function TenantFrame({ children }: { children: ReactNode }) {
  return (
    <AuthGate mode="tenant">
      <TenantFrameInner>{children}</TenantFrameInner>
    </AuthGate>
  );
}

function TenantFrameInner({ children }: { children: ReactNode }) {
  const me = useAuthStore((state) => state.user);
  if (!me) return null;
  const hasTenant = !!me.tenant;
  return (
    <AppFrame
      groups={hasTenant ? buildTenantNav(me) : buildPlatformNav()}
      subtitle={me.tenant?.name ?? "Klyp"}
      withBell={hasTenant}
    >
      {children}
    </AppFrame>
  );
}

export function PlatformFrame({ children }: { children: ReactNode }) {
  return (
    <AuthGate mode="platform">
      <AppFrame groups={buildPlatformNav()} subtitle="Panel de Klyp" withBell={false}>
        {children}
      </AppFrame>
    </AuthGate>
  );
}
