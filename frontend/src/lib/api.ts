import { API_PREFIX } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { useAuthStore } from "@/stores/auth-store";
import type { ApiErrorBody } from "@/types/api";

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /** No intentar refrescar la sesión ante un 401 (login, refresh...). */
  skipRefresh?: boolean;
}

interface AuthHooks {
  /** Se llama cuando la sesión no se puede recuperar (refresh fallido). */
  onSessionExpired?: () => void;
  /** Se llama cuando el backend exige activar el 2FA. */
  onTwoFactorSetupRequired?: () => void;
}

const hooks: AuthHooks = {};

export function setAuthHooks(next: AuthHooks): void {
  hooks.onSessionExpired = next.onSessionExpired;
  hooks.onTwoFactorSetupRequired = next.onTwoFactorSetupRequired;
}

export function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  return new ApiError({
    status: response.status,
    code: body?.error?.code ?? "UNKNOWN",
    message: body?.error?.message ?? "Ha ocurrido un error inesperado.",
    field: body?.error?.field ?? null,
    requestId: body?.error?.request_id ?? null,
  });
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = useAuthStore.getState().accessToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  try {
    return await fetch(`${API_PREFIX}${path}${buildQuery(options.query)}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "include",
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: "No hay conexión con el servidor.",
    });
  }
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Pide un nuevo access token con la cookie de refresh. Las llamadas simultáneas
 * comparten una sola petición (el backend rota el refresh token en cada uso).
 */
export function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const response = await send("/auth/refresh", { method: "POST" });
        if (!response.ok) return false;
        const data = (await response.json()) as { access_token?: string };
        if (!data.access_token) return false;
        useAuthStore.getState().setAccessToken(data.access_token);
        return true;
      } catch {
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await send(path, options);

  if (response.status === 401 && !options.skipRefresh) {
    const refreshed = await refreshSession();
    if (refreshed) {
      response = await send(path, options);
    } else {
      useAuthStore.getState().clear();
      hooks.onSessionExpired?.();
    }
  }

  if (!response.ok) {
    const error = await toApiError(response);
    if (error.code === "TWO_FACTOR_SETUP_REQUIRED") hooks.onTwoFactorSetupRequired?.();
    throw error;
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) =>
    apiFetch<T>(path, { query, signal }),
  post: <T = void>(path: string, body?: unknown, options?: Pick<RequestOptions, "skipRefresh">) =>
    apiFetch<T>(path, { method: "POST", body, ...options }),
  put: <T = void>(path: string, body?: unknown) => apiFetch<T>(path, { method: "PUT", body }),
  patch: <T = void>(path: string, body?: unknown) => apiFetch<T>(path, { method: "PATCH", body }),
  delete: <T = void>(path: string, query?: Record<string, QueryValue>) =>
    apiFetch<T>(path, { method: "DELETE", query }),
};
