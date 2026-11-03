import type { Metadata } from "next";

import { RolesList } from "@/components/roles/roles-list";

export const metadata: Metadata = { title: "Roles y permisos" };

export default function RolesPage() {
  return <RolesList />;
}
