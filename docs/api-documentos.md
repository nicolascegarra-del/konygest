# API — Destino de los documentos de cada empresa

Cada empresa elige dónde se guardan sus documentos (albaranes, órdenes de carga y, más adelante,
facturas, abonos y documentos de trazabilidad): **Google Drive**, **OneDrive / SharePoint**, una
**carpeta de red (SMB)** o, si no configura nada, el **almacenamiento de Konygest** (carpeta del
servidor o MinIO, según `STORAGE_BACKEND`).

Decisión del usuario: el destino elegido es el **almacén principal** (no una copia). Para que un
fichero borrado o un servicio caído nunca impida ver un documento, cada documento queda registrado
en la base de datos con el origen de sus datos y, si al pedirlo no está en el destino, **se regenera**
desde la base de datos (que es el registro oficial) y se vuelve a guardar.

## Conceptos

- **Configuración de almacenamiento** (`tenant_storage`, una por empresa): proveedor, ajustes no
  secretos (carpeta, servidor…) y credenciales **cifradas** con `ENCRYPTION_KEY` (refresh token de
  OAuth o contraseña SMB). Las credenciales nunca se devuelven al cliente.
- **Documento** (`stored_document`): registro de cada fichero guardado:
  `{tenant_id, kind, number, filename, content_type, provider, location, size, sha256, source_type, source_id, created_at}`.
  - `kind`: `delivery_note` (albarán), `loading_order` (orden de carga); fases posteriores añaden `invoice`, `credit_note`…
  - `provider` y `location` son **donde se guardó** (id de fichero en Drive/OneDrive, ruta SMB o clave
    local): si la empresa cambia de destino, los documentos antiguos siguen donde estaban y se leen de allí.
  - `source_type`/`source_id` (p. ej. `load_stop` + id) permiten regenerarlo.
- **Estructura de carpetas** en el destino: `<carpeta raíz>/<Tipo>/<Año>/<número>.pdf`, p. ej.
  `Konygest/Albaranes/2026/ALB-2026-0001.pdf`. Tipos: `Albaranes`, `Ordenes de carga` (y después
  `Facturas`, `Abonos`…).

## Proveedores

| `provider` | Conexión | Ajustes (`settings`) | Secreto cifrado |
|---|---|---|---|
| `platform` | Ninguna (por defecto) | — | — |
| `google_drive` | OAuth 2.0 (botón «Conectar con Google»). Ámbito `drive.file`: la app solo ve los ficheros y carpetas que crea ella | `root_folder_name` (def. `Konygest`), `shared_drive_id?` (unidad compartida opcional) | refresh token |
| `onedrive` | OAuth 2.0 con Microsoft identity platform (botón «Conectar con Microsoft»). Ámbitos `Files.ReadWrite offline_access User.Read` (y `Sites.ReadWrite.All` si se usa SharePoint) | `root_path` (def. `/Konygest`), `site_url?` (biblioteca de SharePoint opcional; si va, se usa su unidad por defecto) | refresh token |
| `smb` | Usuario y contraseña | `server` (host o IP), `share`, `root_path` (def. `Konygest`), `username`, `domain?`, `port?` (445) | contraseña |

El servidor de Konygest tiene que poder llegar a la carpeta SMB (IP pública, VPN o Tailscale).
Una carpeta de un PC concreto solo es posible si ese PC la comparte en red o la sincroniza con Drive/OneDrive.

Los botones de Google y Microsoft solo aparecen si la plataforma tiene configuradas sus
credenciales OAuth (variables de entorno de abajo).

## Rutas (permiso `empresa.configurar`, módulo core)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/tenant/storage` | Configuración actual (sin secretos) y proveedores disponibles |
| PUT | `/tenant/storage` | Guardar proveedor y ajustes. Para `google_drive`/`onedrive` exige haber conectado antes la cuenta (si no, 400 `NOT_CONNECTED`). Para `smb`, `password` en el cuerpo (si se omite al editar, se conserva la guardada **solo si no cambian `server`, `share` ni `username`**; si cambian, 400 `VALIDATION_ERROR` con `field: "password"`, para no enviar la contraseña guardada a otro servidor). Prueba la conexión antes de guardar: si falla, 400 `STORAGE_CONNECTION_FAILED` con el motivo y no guarda |
| DELETE | `/tenant/storage` | Volver al almacenamiento de Konygest (borra las credenciales y cuentas de todos los proveedores; los documentos ya guardados siguen en su destino y, como ya no se pueden leer de allí, se regeneran al pedirlos). Devuelve la configuración como el `GET` |
| POST | `/tenant/storage/test` | Escribe, lee y borra un fichero de prueba en el destino actual → `{ok, message, elapsed_ms}` |
| POST | `/tenant/storage/oauth/{google_drive\|onedrive}/start` | → `{authorize_url}`. El `state` es un JWT firmado de 10 min con empresa, usuario y proveedor. Sin credenciales de la plataforma: 400 `PROVIDER_NOT_CONFIGURED`. Opcional `?sharepoint=true` (OneDrive): pide también `Sites.ReadWrite.All`; se pide solo si ya hay un `site_url` guardado |
| GET | `/tenant/storage/oauth/{google_drive\|onedrive}/callback?code=&state=` | **Pública** (la llama el navegador al volver de Google/Microsoft; se autentica por el `state`). Intercambia el código, guarda el refresh token cifrado y la cuenta conectada, y redirige a `{APP_URL}/ajustes/documentos?connected=<provider>` (o `?error=<código>`: `access_denied`, `INVALID_STATE`, `OAUTH_FAILED`, `PROVIDER_NOT_CONFIGURED`, `FORBIDDEN`). Conectar **activa** ese proveedor con sus ajustes guardados o los de por defecto (Drive `root_folder_name="Konygest"`, OneDrive `root_path="/Konygest"`) |
| GET | `/tenant/storage/documents?kind=&search=` | Paginado: documentos guardados de la empresa `{id, kind, number, filename, provider, size, created_at, source_type, source_id}` |

### `GET /tenant/storage`

```json
{
  "provider": "google_drive",
  "settings": {"root_folder_name": "Konygest", "shared_drive_id": null},
  "connected_account": "oficina@piensosnorte.es",
  "has_secret": true,
  "status": "ok",
  "last_error": null,
  "last_checked_at": "2026-11-04T08:12:00Z",
  "updated_at": "2026-11-04T08:10:00Z",
  "updated_by_name": "Ana Administradora",
  "available_providers": ["platform", "google_drive", "onedrive", "smb"]
}
```
`status`: `ok` | `error` (último uso o prueba fallida; `last_error` con el motivo) | `not_configured`.

### `PUT /tenant/storage`

```json
{"provider": "smb", "settings": {"server": "nas.piensosnorte.es", "share": "documentos", "root_path": "Konygest", "username": "konygest", "domain": null}, "password": "…"}
```

## API interna para los módulos (backend)

Sustituye al uso directo de `documents.storage` en logística (y lo usarán facturación y demás):

- `documents.store(db, tenant_id, kind, number, data, content_type, source_type, source_id) -> StoredDocument`
  guarda en el destino actual de la empresa y registra el documento (si ya existe uno con ese
  `kind`+`number`, lo sustituye). Si el destino falla, se registra en `tenant_storage.last_error`,
  se avisa a quien tenga `empresa.configurar` (aviso `documentos_error`) y **se guarda en el
  almacenamiento de Konygest** para no perder el documento (`provider = "platform"`).
- `documents.fetch(db, tenant_id, kind, number, regenerate: Callable[[], bytes], *, content_type="application/pdf", source_type=None, source_id=None) -> bytes`
  lee del destino donde se guardó; si no existe o el destino no responde, llama a `regenerate()`,
  vuelve a guardarlo con `store` y lo devuelve. `source_type`/`source_id` sirven para registrar
  un documento que aún no tenía registro. Los cambios en BD los confirma quien llama (`commit`).
- `documents.stored_numbers(db, tenant_id, kind, numbers) -> set[str]`: qué números tienen
  documento registrado (una consulta; logística lo usa para `delivery_note_ready`).
- La carpeta del año es la del registro original al sustituir o regenerar un documento.
- `LoadStop.delivery_note_key` se **elimina** (migración `documentos destinos`): el albarán se
  localiza por `kind="delivery_note"` y su número. Los albaranes ya guardados con esa clave pasan a
  `stored_document` con `provider="platform"` y la misma clave.

## Límites y detalles de cada proveedor

- **OneDrive**: subida simple (`PUT …:/content`), hasta **4 MB por fichero**. Un documento mayor
  no se sube y se guarda en el almacenamiento de Konygest (con aviso). Los albaranes ocupan
  decenas de KB. Microsoft rota el refresh token en cada uso: se guarda el nuevo cifrado.
- **Google Drive**: las carpetas se buscan por nombre dentro de su carpeta padre antes de crearlas
  (con `drive.file` solo se ven las que creó Konygest); un fichero con el mismo nombre en la misma
  carpeta se sustituye.
- **SMB**: tiempo de espera de conexión de 10 s; cada operación abre y cierra su propia sesión
  (dos empresas con el mismo servidor nunca comparten sesión). La ubicación es la ruta UNC; solo
  se lee si está en el servidor y recurso configurados.

## Configuración de la plataforma (variables de entorno)

| Variable | Uso |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | App de Google Cloud (OAuth, Drive API activada) |
| `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_TENANT` (def. `common`) | App registrada en Microsoft Entra |

URI de redirección a registrar en cada proveedor: `{APP_URL}/api/v1/tenant/storage/oauth/<provider>/callback`.

## Avisos y auditoría

- Aviso nuevo `documentos_error` («No se pudo guardar un documento en el destino configurado»), a
  quien tenga `empresa.configurar`, como mucho uno al día por empresa.
- Auditoría: `documentos.destino` (cambio de proveedor/ajustes, sin secretos), `documentos.conectar`, `documentos.desconectar`.
