import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentStorageSettings } from "@/components/settings/document-storage";
import { buildSmbPayload } from "@/components/settings/storage-provider-forms";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { useAuthStore } from "@/stores/auth-store";
import { renderWithQuery } from "@/test/query-wrapper";
import type { Me } from "@/types/api";
import type { TenantStorage } from "@/types/documents";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const replace = vi.fn();
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, back: vi.fn() }),
  useSearchParams: () => searchParams,
}));

const mockedApi = vi.mocked(api);
const mockedToast = vi.mocked(toast);

const ALL_PROVIDERS: TenantStorage["available_providers"] = ["platform", "google_drive", "onedrive", "smb"];

function storage(overrides: Partial<TenantStorage> = {}): TenantStorage {
  return {
    provider: "platform",
    settings: null,
    connected_account: null,
    has_secret: false,
    status: "ok",
    last_error: null,
    last_checked_at: null,
    updated_at: null,
    updated_by_name: null,
    available_providers: ALL_PROVIDERS,
    ...overrides,
  };
}

const SMB_SAVED = storage({
  provider: "smb",
  settings: { server: "nas.piensos.es", share: "documentos", root_path: "Konygest", username: "konygest", domain: null, port: null },
  has_secret: true,
  updated_at: "2026-11-04T08:10:00Z",
  updated_by_name: "Ana Administradora",
});

const DRIVE_CONNECTED = storage({
  provider: "google_drive",
  settings: { root_folder_name: "Konygest", shared_drive_id: null },
  connected_account: "oficina@piensos.es",
  has_secret: true,
  updated_at: "2026-11-04T08:10:00Z",
});

function me(overrides: Partial<Me> = {}): Me {
  return {
    id: "u-1",
    email: "ana@example.com",
    full_name: "Ana Administradora",
    tenant: { id: "t-1", name: "Piensos" },
    platform_role: null,
    permissions: { "empresa.configurar": "all" },
    modules: ["core"],
    support_mode: false,
    read_only: false,
    totp_enabled: false,
    must_setup_2fa: false,
    ...overrides,
  };
}

function setup(config: TenantStorage, user: Me = me()) {
  mockedApi.get.mockImplementation(async (path: string) => {
    if (path === "/tenant/storage") return config;
    if (path === "/tenant/storage/documents") return { items: [], total: 0, offset: 0, limit: 25 };
    throw new Error(`GET inesperado: ${path}`);
  });
  useAuthStore.setState({ user, status: "authenticated" });
  renderWithQuery(<DocumentStorageSettings />);
  return userEvent.setup();
}

async function chooseProvider(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
  await user.click(await screen.findByRole("radio", { name: label }));
}

describe("buildSmbPayload", () => {
  const values = {
    server: " nas.piensos.es ",
    share: "documentos",
    root_path: "",
    username: "konygest",
    domain: "",
    port: "",
    password: "",
  };

  it("omite la contraseña cuando no se cambia y normaliza los opcionales", () => {
    expect(buildSmbPayload(values)).toEqual({
      provider: "smb",
      settings: { server: "nas.piensos.es", share: "documentos", root_path: "Konygest", username: "konygest", domain: null, port: null },
    });
  });

  it("incluye la contraseña y el puerto cuando se indican", () => {
    const payload = buildSmbPayload({ ...values, password: "secreta", port: "4450", domain: "OFICINA" });
    expect(payload).toMatchObject({ password: "secreta", settings: { port: 4450, domain: "OFICINA" } });
  });
});

describe("DocumentStorageSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sin el permiso empresa.configurar no pide la configuración", async () => {
    setup(storage(), me({ permissions: {} }));
    expect(await screen.findByText("No tienes permiso para configurar los documentos")).toBeInTheDocument();
    expect(mockedApi.get).not.toHaveBeenCalled();
  });

  it("en solo lectura muestra el aviso y desactiva las acciones", async () => {
    setup(storage(), me({ read_only: true }));
    expect(await screen.findByText(/La cuenta está en solo lectura/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Probar conexión/ })).toBeDisabled();
  });

  it("muestra el destino actual y prueba la conexión", async () => {
    mockedApi.post.mockResolvedValue({ ok: true, message: "Conexión correcta", elapsed_ms: 120 });
    const user = setup(SMB_SAVED);
    expect(await screen.findByTestId("current-provider")).toHaveTextContent("Carpeta de red (SMB)");
    await user.click(screen.getByRole("button", { name: /Probar conexión/ }));
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledWith("/tenant/storage/test"));
    expect(mockedToast.success).toHaveBeenCalledWith("Conexión correcta (120 ms)");
  });

  it("al elegir SMB por primera vez exige la contraseña y la envía", async () => {
    mockedApi.put.mockResolvedValue(SMB_SAVED);
    const user = setup(storage());
    await chooseProvider(user, /Carpeta de red/);

    expect(screen.getByText(/Al cambiar de destino, los documentos ya guardados siguen donde están/)).toBeInTheDocument();
    expect(screen.getByText(/IP pública, una VPN o Tailscale/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Servidor"), "nas.piensos.es");
    await user.type(screen.getByLabelText("Recurso compartido"), "documentos");
    await user.type(screen.getByLabelText("Usuario"), "konygest");
    await user.click(screen.getByRole("button", { name: "Probar y guardar" }));
    expect(await screen.findByText("Indica la contraseña.")).toBeInTheDocument();
    expect(mockedApi.put).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Contraseña"), "secreta");
    await user.click(screen.getByRole("button", { name: "Probar y guardar" }));
    await waitFor(() =>
      expect(mockedApi.put).toHaveBeenCalledWith("/tenant/storage", {
        provider: "smb",
        settings: { server: "nas.piensos.es", share: "documentos", root_path: "Konygest", username: "konygest", domain: null, port: null },
        password: "secreta",
      }),
    );
    expect(mockedToast.success).toHaveBeenCalledWith("Destino de los documentos guardado.");
  });

  it("al editar SMB conserva la contraseña guardada si no se cambia", async () => {
    mockedApi.put.mockResolvedValue(SMB_SAVED);
    const user = setup(SMB_SAVED);
    const share = await screen.findByLabelText("Recurso compartido");
    expect(screen.getByText(/Hay una contraseña guardada/)).toBeInTheDocument();

    await user.clear(share);
    await user.type(share, "docs");
    await user.click(screen.getByRole("button", { name: "Probar y guardar" }));
    await waitFor(() => expect(mockedApi.put).toHaveBeenCalledTimes(1));
    const payload = mockedApi.put.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload).toEqual({
      provider: "smb",
      settings: { server: "nas.piensos.es", share: "docs", root_path: "Konygest", username: "konygest", domain: null, port: null },
    });
    expect(payload).not.toHaveProperty("password");
  });

  it("muestra STORAGE_CONNECTION_FAILED en el formulario y no lanza un toast", async () => {
    mockedApi.put.mockRejectedValue(
      new ApiError({ status: 400, code: "STORAGE_CONNECTION_FAILED", message: "Acceso denegado a \\\\nas.piensos.es\\docs" }),
    );
    const user = setup(SMB_SAVED);
    await user.type(await screen.findByLabelText("Contraseña"), "otra");
    await user.click(screen.getByRole("button", { name: "Probar y guardar" }));

    const alert = await screen.findByTestId("connection-failed");
    expect(within(alert).getByText(/No se ha guardado nada/)).toBeInTheDocument();
    expect(within(alert).getByText("Acceso denegado a \\\\nas.piensos.es\\docs")).toBeInTheDocument();
    expect(mockedToast.error).not.toHaveBeenCalled();
  });

  it("el botón de conectar pide start y redirige a Google", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    mockedApi.post.mockResolvedValue({ authorize_url: "https://accounts.google.com/o/oauth2/auth?state=abc" });
    const user = setup(storage());
    await chooseProvider(user, /Google Drive/);
    await user.click(screen.getByRole("button", { name: "Conectar con Google" }));

    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledWith("/tenant/storage/oauth/google_drive/start"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/auth?state=abc"));
  });

  it("con la cuenta conectada muestra la cuenta y el formulario de carpeta", async () => {
    setup(DRIVE_CONNECTED);
    expect(await screen.findByText("oficina@piensos.es", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByLabelText("Carpeta raíz")).toHaveValue("Konygest");
    expect(screen.getByRole("button", { name: "Cambiar de cuenta" })).toBeInTheDocument();
  });

  it("al volver con ?connected= avisa, refresca y limpia la URL", async () => {
    searchParams = new URLSearchParams("connected=google_drive");
    setup(DRIVE_CONNECTED);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/ajustes/documentos"));
    expect(mockedToast.success).toHaveBeenCalledTimes(1);
    expect(mockedToast.success.mock.calls[0]![0]).toMatch(/Cuenta de Google Drive conectada/);
    expect(await screen.findByRole("radio", { name: /Google Drive/ })).toBeChecked();
  });

  it("al volver con ?error= muestra el motivo y limpia la URL", async () => {
    searchParams = new URLSearchParams("error=access_denied");
    setup(storage());
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/ajustes/documentos"));
    expect(mockedToast.error).toHaveBeenCalledWith("Has cancelado la conexión: no se ha conectado ninguna cuenta.");
    expect(mockedToast.success).not.toHaveBeenCalled();
  });

  it("al volver con un código de la API usa el mensaje de errors.ts", async () => {
    searchParams = new URLSearchParams("error=PROVIDER_NOT_CONFIGURED");
    setup(storage());
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith("Este destino no está disponible en la plataforma ahora mismo. Contacta con Klyp."),
    );
  });

  it("volver a Konygest pide confirmación y hace DELETE", async () => {
    mockedApi.delete.mockResolvedValue(undefined);
    const user = setup(DRIVE_CONNECTED);
    await chooseProvider(user, /Almacenamiento de Konygest/);
    expect(screen.getByText(/Al cambiar de destino, los documentos ya guardados siguen donde están/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Usar este" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Los documentos ya guardados allí se quedan donde están/)).toBeInTheDocument();
    expect(mockedApi.delete).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Usar Konygest" }));

    await waitFor(() => expect(mockedApi.delete).toHaveBeenCalledWith("/tenant/storage"));
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalledWith("Los documentos nuevos se guardarán en el almacenamiento de Konygest."));
  });

  it("cancelar la confirmación no borra nada", async () => {
    const user = setup(DRIVE_CONNECTED);
    await chooseProvider(user, /Almacenamiento de Konygest/);
    await user.click(screen.getByRole("button", { name: "Usar este" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockedApi.delete).not.toHaveBeenCalled();
  });

  it("si falla la carga muestra el estado de error", async () => {
    mockedApi.get.mockRejectedValue(new ApiError({ status: 500, code: "INTERNAL_ERROR", message: "boom" }));
    useAuthStore.setState({ user: me(), status: "authenticated" });
    renderWithQuery(<DocumentStorageSettings />);
    expect(await screen.findByRole("button", { name: /Reintentar/ })).toBeInTheDocument();
  });

  it("sin documentos guardados muestra el estado vacío", async () => {
    setup(storage());
    expect(await screen.findByText("Aún no se ha guardado ningún documento")).toBeInTheDocument();
  });
});
