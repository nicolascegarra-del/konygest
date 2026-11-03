import { api, refreshSession } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import type { LoginResponse, Me } from "@/types/api";

/** Ruta a la que llevar a cada tipo de usuario tras iniciar sesión. */
export function homePathFor(me: Me): string {
  if (me.must_setup_2fa) return "/cuenta/seguridad";
  if (me.platform_role && !me.tenant) return "/admin";
  return "/inicio";
}

let bootstrapInFlight: Promise<boolean> | null = null;

/**
 * Recupera la sesión al cargar la página: el access token solo está en memoria, así que se
 * pide uno nuevo con la cookie de refresh y se carga el usuario. Devuelve si hay sesión.
 */
export function bootstrapSession(): Promise<boolean> {
  if (!bootstrapInFlight) {
    bootstrapInFlight = (async () => {
      try {
        const refreshed = await refreshSession();
        if (!refreshed) {
          useAuthStore.getState().clear();
          return false;
        }
        const me = await api.get<Me>("/me");
        useAuthStore.getState().setUser(me);
        return true;
      } catch {
        useAuthStore.getState().clear();
        return false;
      } finally {
        bootstrapInFlight = null;
      }
    })();
  }
  return bootstrapInFlight;
}

export async function login(params: {
  email: string;
  password: string;
  totpCode?: string;
}): Promise<Me> {
  const response = await api.post<LoginResponse>(
    "/auth/login",
    { email: params.email, password: params.password, totp_code: params.totpCode },
    { skipRefresh: true },
  );
  useAuthStore.getState().setSession(response.access_token, response.user);
  return response.user;
}

/** Cierra la sesión en el servidor (borra la cookie) y limpia el estado local. */
export async function logout(): Promise<void> {
  try {
    await api.post("/auth/logout", undefined, { skipRefresh: true });
  } finally {
    useAuthStore.getState().clear();
  }
}

export async function reloadMe(): Promise<Me> {
  const me = await api.get<Me>("/me");
  useAuthStore.getState().setUser(me);
  return me;
}

export function can(me: Me | null, permission: string): boolean {
  return !!me && permission in me.permissions;
}
