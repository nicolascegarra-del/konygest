import type { Metadata } from "next";

import { UsersPage } from "@/components/users/users-page";

export const metadata: Metadata = { title: "Usuarios" };

export default function UsersRoutePage() {
  return <UsersPage />;
}
