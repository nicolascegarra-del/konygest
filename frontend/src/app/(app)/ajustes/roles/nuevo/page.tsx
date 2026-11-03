import type { Metadata } from "next";

import { RoleEditor } from "@/components/roles/role-editor";

export const metadata: Metadata = { title: "Nuevo rol" };

export default function NewRolePage() {
  return <RoleEditor roleId={null} />;
}
