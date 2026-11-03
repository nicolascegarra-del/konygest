"use client";

import { useParams } from "next/navigation";

import { TenantDetail } from "@/components/admin/tenant-detail";

export default function AdminTenantDetailPage() {
  const params = useParams<{ id: string }>();
  return <TenantDetail tenantId={params.id} />;
}
