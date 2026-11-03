"use client";

import { SecurityPanel } from "@/components/account/security";
import { PageHeader } from "@/components/common/states";
import { useAuthStore } from "@/stores/auth-store";

export default function SecurityPage() {
  const me = useAuthStore((state) => state.user);
  if (!me) return null;
  return (
    <>
      <PageHeader title="Seguridad" />
      <SecurityPanel me={me} />
    </>
  );
}
