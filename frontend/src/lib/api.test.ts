import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, apiFetch, setAuthHooks } from "@/lib/api";
import { ApiError, friendlyMessage } from "@/lib/errors";
import { useAuthStore } from "@/stores/auth-store";

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

function callsTo(path: string): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`/api/v1${path}`)).length;
}

function authHeaderOfCall(index: number): string | undefined {
  const init = fetchMock.mock.calls[index]?.[1];
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

describe("cliente API", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    useAuthStore.setState({ status: "authenticated", accessToken: "token-viejo", user: null, platformToken: null });
    setAuthHooks({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("añade el Bearer y envía las cookies", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await api.get("/me");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/me");
    expect(init?.credentials).toBe("include");
    expect(authHeaderOfCall(0)).toBe("Bearer token-viejo");
  });

  it("ante un 401 refresca una vez y repite la petición con el token nuevo", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "INVALID_TOKEN", message: "caducado" } }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "token-nuevo" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "1" }));

    const result = await api.get<{ id: string }>("/me");

    expect(result).toEqual({ id: "1" });
    expect(callsTo("/auth/refresh")).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(authHeaderOfCall(2)).toBe("Bearer token-nuevo");
    expect(useAuthStore.getState().accessToken).toBe("token-nuevo");
  });

  it("si el refresh falla, limpia la sesión, avisa y lanza el error", async () => {
    const onSessionExpired = vi.fn();
    setAuthHooks({ onSessionExpired });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "INVALID_TOKEN", message: "caducado" } }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "INVALID_TOKEN", message: "sin sesión" } }));

    await expect(api.get("/me")).rejects.toMatchObject({ code: "INVALID_TOKEN", status: 401 });

    expect(callsTo("/auth/refresh")).toBe(1);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().status).toBe("anonymous");
  });

  it("no reintenta más de una vez si la petición repetida vuelve a dar 401", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "INVALID_TOKEN", message: "x" } }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "token-nuevo" }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "INVALID_TOKEN", message: "x" } }));

    await expect(api.get("/me")).rejects.toBeInstanceOf(ApiError);

    expect(callsTo("/auth/refresh")).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("comparte un único refresh entre peticiones simultáneas", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/v1/auth/refresh")) return jsonResponse(200, { access_token: "token-nuevo" });
      const bearer = useAuthStore.getState().accessToken;
      return bearer === "token-nuevo" ? jsonResponse(200, { ok: true }) : jsonResponse(401, { error: { code: "INVALID_TOKEN" } });
    });

    await Promise.all([api.get("/a"), api.get("/b")]);

    expect(callsTo("/auth/refresh")).toBe(1);
  });

  it("no intenta refrescar con skipRefresh (login)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { code: "INVALID_CREDENTIALS", message: "mal" } }));

    await expect(apiFetch("/auth/login", { method: "POST", body: {}, skipRefresh: true })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });

    expect(callsTo("/auth/refresh")).toBe(0);
  });

  it("convierte el formato de error estándar en ApiError con code, message y field", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, { error: { code: "VALIDATION_ERROR", message: "El email no es válido.", field: "email", request_id: "req_1" } }),
    );

    const error = await api.post("/users", {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "VALIDATION_ERROR", message: "El email no es válido.", field: "email", requestId: "req_1" });
    expect(friendlyMessage(error)).toBe("El email no es válido.");
  });

  it("avisa cuando el backend exige activar el 2FA", async () => {
    const onTwoFactorSetupRequired = vi.fn();
    setAuthHooks({ onTwoFactorSetupRequired });
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: { code: "TWO_FACTOR_SETUP_REQUIRED", message: "x" } }));

    await expect(api.get("/tenant")).rejects.toMatchObject({ code: "TWO_FACTOR_SETUP_REQUIRED" });

    expect(onTwoFactorSetupRequired).toHaveBeenCalledTimes(1);
  });

  it("devuelve undefined en un 204 y NETWORK_ERROR si falla la red", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(204));
    await expect(api.post("/auth/logout")).resolves.toBeUndefined();

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(api.get("/me")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("construye la query sin valores vacíos", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));

    await api.get("/users", { search: "", offset: 0, limit: 25, status: undefined });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/users?offset=0&limit=25");
  });
});

describe("api.blob (PDF autenticado)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    useAuthStore.setState({ status: "authenticated", accessToken: "token-viejo", user: null, platformToken: null });
    setAuthHooks({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("descarga con el Bearer, refresca ante un 401 y lee el nombre de Content-Disposition", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "INVALID_TOKEN", message: "caducado" } }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "token-nuevo" }))
      .mockResolvedValueOnce(
        new Response("%PDF-1.7", {
          status: 200,
          headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="CAR-2026-0001.pdf"' },
        }),
      );

    const { blob, filename } = await api.blob("/loads/l-1/loading-order.pdf");

    expect(filename).toBe("CAR-2026-0001.pdf");
    expect(await blob.text()).toBe("%PDF-1.7");
    expect(authHeaderOfCall(2)).toBe("Bearer token-nuevo");
  });

  it("convierte el 503 PDF_UNAVAILABLE en ApiError con mensaje claro", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: { code: "PDF_UNAVAILABLE", message: "WeasyPrint no disponible" } }));

    const error = await api.blob("/loads/l-1/loading-order.pdf").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(friendlyMessage(error)).toBe("No se pueden generar PDF en este servidor ahora mismo.");
  });
});
