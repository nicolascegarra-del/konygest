import { beforeEach, describe, expect, it } from "vitest";

import { useAuthStore } from "@/stores/auth-store";
import type { Me } from "@/types/api";

const me: Me = {
  id: "u1",
  email: "ana@fabrica.es",
  full_name: "Ana Pérez",
  tenant: { id: "t1", name: "Piensos Norte" },
  platform_role: null,
  permissions: { "usuarios.ver": "all" },
  modules: [],
  support_mode: false,
  read_only: false,
  totp_enabled: false,
  must_setup_2fa: false,
};

describe("auth store", () => {
  beforeEach(() => {
    useAuthStore.getState().clear();
    useAuthStore.setState({ status: "unknown" });
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("empieza sin saber si hay sesión", () => {
    expect(useAuthStore.getState()).toMatchObject({ status: "unknown", accessToken: null, user: null });
  });

  it("setSession guarda token y usuario y marca la sesión como autenticada", () => {
    useAuthStore.getState().setSession("abc", me);

    expect(useAuthStore.getState()).toMatchObject({ status: "authenticated", accessToken: "abc", user: me });
  });

  it("nunca guarda el access token en localStorage ni sessionStorage", () => {
    useAuthStore.getState().setSession("secreto", me);
    useAuthStore.getState().setAccessToken("secreto-2");

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("clear borra la sesión y deja el estado como anónimo", () => {
    useAuthStore.getState().setSession("abc", me);

    useAuthStore.getState().clear();

    expect(useAuthStore.getState()).toMatchObject({ status: "anonymous", accessToken: null, user: null, platformToken: null });
  });

  it("modo soporte: guarda el token propio y lo restaura al salir", () => {
    useAuthStore.getState().setSession("token-klyp", me);

    useAuthStore.getState().enterSupport("token-soporte");
    expect(useAuthStore.getState()).toMatchObject({ accessToken: "token-soporte", platformToken: "token-klyp" });

    const restored = useAuthStore.getState().exitSupport();
    expect(restored).toBe("token-klyp");
    expect(useAuthStore.getState()).toMatchObject({ accessToken: "token-klyp", platformToken: null });
  });

  it("entrar dos veces en modo soporte conserva el token propio original", () => {
    useAuthStore.getState().setSession("token-klyp", me);

    useAuthStore.getState().enterSupport("soporte-1");
    useAuthStore.getState().enterSupport("soporte-2");

    expect(useAuthStore.getState().platformToken).toBe("token-klyp");
  });

  it("salir del modo soporte sin haber entrado no cambia el token", () => {
    useAuthStore.getState().setSession("token-klyp", me);

    expect(useAuthStore.getState().exitSupport()).toBeNull();
    expect(useAuthStore.getState().accessToken).toBe("token-klyp");
  });
});
