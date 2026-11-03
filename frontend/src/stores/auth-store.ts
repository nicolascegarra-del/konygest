import { create } from "zustand";

import type { Me } from "@/types/api";

/**
 * Estado de sesión. El access token vive SOLO en memoria (nunca en localStorage ni
 * sessionStorage): al recargar, el cliente lo recupera con POST /auth/refresh.
 */
export type AuthStatus = "unknown" | "authenticated" | "anonymous";

interface AuthState {
  status: AuthStatus;
  accessToken: string | null;
  user: Me | null;
  /** Token propio de Klyp mientras se está en modo soporte dentro de una empresa. */
  platformToken: string | null;
  setSession: (accessToken: string, user: Me) => void;
  setAccessToken: (accessToken: string) => void;
  setUser: (user: Me) => void;
  enterSupport: (supportToken: string) => void;
  exitSupport: () => string | null;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: "unknown",
  accessToken: null,
  user: null,
  platformToken: null,
  setSession: (accessToken, user) => set({ status: "authenticated", accessToken, user }),
  setAccessToken: (accessToken) => set({ accessToken }),
  setUser: (user) => set({ user, status: "authenticated" }),
  enterSupport: (supportToken) =>
    set((state) => ({
      platformToken: state.platformToken ?? state.accessToken,
      accessToken: supportToken,
    })),
  exitSupport: () => {
    const { platformToken } = get();
    if (platformToken) set({ accessToken: platformToken, platformToken: null });
    return platformToken;
  },
  clear: () => set({ status: "anonymous", accessToken: null, user: null, platformToken: null }),
}));
