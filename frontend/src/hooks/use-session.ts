"use client";

import { useEffect } from "react";

import { bootstrapSession } from "@/lib/auth";
import { useAuthStore, type AuthStatus } from "@/stores/auth-store";

/** Restaura la sesión una vez al montar (si aún no se sabe si hay sesión). */
export function useSessionBootstrap(): AuthStatus {
  const status = useAuthStore((state) => state.status);
  useEffect(() => {
    if (useAuthStore.getState().status === "unknown") void bootstrapSession();
  }, []);
  return status;
}
