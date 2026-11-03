"use client";

import { ChangePasswordForm, ProfileForm } from "@/components/account/profile-forms";
import { PageHeader } from "@/components/common/states";
import { useAuthStore } from "@/stores/auth-store";

export default function AccountPage() {
  const me = useAuthStore((state) => state.user);
  if (!me) return null;
  return (
    <>
      <PageHeader title="Mi cuenta" />
      <div className="space-y-6">
        <ProfileForm me={me} />
        <ChangePasswordForm />
      </div>
    </>
  );
}
