# Contrato de la API — Fase 0

Prefijo: `/api/v1`. JSON. El frontend llama a `/api/v1/...` en su mismo origen y Next.js lo redirige (rewrites) al backend (`NEXT_PUBLIC_API_URL`, por defecto `http://localhost:8000`). Así la cookie del refresh token es del mismo sitio.

## Autenticación
- Access token JWT (15 min) **solo en memoria** (store Zustand), enviado como `Authorization: Bearer <token>`.
- Refresh token en cookie HttpOnly `kg_refresh` (`SameSite=Strict`, ruta `/api/v1/auth`), la pone y la rota el backend. Al recargar la página, el frontend llama a `POST /auth/refresh` (con `credentials: "include"`) para recuperar el access token.
- Ante un 401 en cualquier llamada: intentar `POST /auth/refresh` una vez y repetir; si falla, ir a `/login`.

## Formato de error
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Texto para el usuario", "field": "email", "request_id": "..." } }
```
Códigos relevantes: `INVALID_CREDENTIALS`, `TOTP_REQUIRED` (pedir código 2FA y reenviar el login con `totp_code`), `TOTP_INVALID`, `ACCOUNT_LOCKED` (423), `TENANT_DISABLED` (403), `RATE_LIMITED` (429), `TWO_FACTOR_SETUP_REQUIRED` (403: llevar a la pantalla de activar 2FA), `SUBSCRIPTION_PAST_DUE` (402: modo solo lectura), `FORBIDDEN`, `NOT_FOUND`, `MODULE_DISABLED`, `WEAK_PASSWORD`, `INVALID_TOKEN`, `CONFLICT`.

## Tipos
```ts
type Scope = "own" | "all";
type Me = {
  id: string; email: string; full_name: string;
  tenant: { id: string; name: string } | null;      // null = personal de Klyp
  platform_role: "superadmin" | "support" | null;
  permissions: Record<string, Scope>;                 // p. ej. { "usuarios.ver": "all" }
  modules: string[];                                  // módulos activos de la empresa
  support_mode: boolean;                              // Klyp dentro de una empresa
  read_only: boolean;                                 // suscripción impagada
  totp_enabled: boolean;
  must_setup_2fa: boolean;
};
type Page<T> = { items: T[]; total: number; offset: number; limit: number };  // ?offset=0&limit=50
type WidgetItem = { widget: string; size: "sm" | "md" | "lg" };
```

## Endpoints
### Auth
| Método | Ruta | Cuerpo → Respuesta |
|---|---|---|
| POST | /auth/login | `{email, password, totp_code?}` → `{access_token, user: Me}` |
| POST | /auth/refresh | — → `{access_token}` |
| POST | /auth/logout | — → 204 |
| POST | /auth/logout-all | — → 204 (cierra todas mis sesiones) |
| POST | /auth/forgot-password | `{email}` → 204 (siempre) |
| POST | /auth/reset-password | `{token, password}` → 204 |
| GET | /auth/invitation?token= | → `{email, full_name, tenant_name}` |
| POST | /auth/accept-invite | `{token, password}` → 204 |
| POST | /auth/2fa/setup | — → `{secret, otpauth_uri}` (mostrar QR de `otpauth_uri`) |
| POST | /auth/2fa/enable | `{code}` → 204 |
| POST | /auth/2fa/disable | `{password, code}` → 204 |

Contraseña mínima: 10 caracteres. Enlaces de email: `/invitacion?token=...` y `/restablecer?token=...`.

### Yo
| GET | /me | → `Me` |
|---|---|---|
| PATCH | /me | `{full_name}` → `Me` |
| POST | /me/password | `{current_password, new_password}` → 204 |
| GET | /me/dashboard | → `{layout: WidgetItem[], customized: boolean, catalog: {code, name, description}[]}` (catálogo ya filtrado por mis permisos) |
| PUT | /me/dashboard | `{layout: WidgetItem[]}` → igual que GET |
| DELETE | /me/dashboard | → igual que GET (vuelve a la del rol) |

Widgets de la fase 0: `bienvenida`, `accesos_rapidos`, `notificaciones`, `resumen_empresa` (usa `GET /tenant/summary`).

### Notificaciones
| GET | /notifications?unread_only=bool | → `Page<{id, type, title, body, link, read_at, created_at}>` |
|---|---|---|
| GET | /notifications/unread-count | → `{unread}` (sondear cada 30 s) |
| POST | /notifications/{id}/read | → 204 |
| POST | /notifications/read-all | → 204 |
| GET/PUT | /notifications/preferences | `{type, name, in_app, email, push}[]` (lo mío) |
| GET/PUT | /notifications/tenant-settings | igual, canales permitidos en la empresa (permiso `notificaciones.configurar`) |
| GET | /notifications/push/public-key | → `{public_key}` (vacío = push no configurado) |
| POST | /notifications/push/subscriptions | `{endpoint, p256dh, auth}` → 204 |
| DELETE | /notifications/push/subscriptions?endpoint= | → 204 |

### Empresa
| GET | /tenant | → `{id, name, tax_id, status, require_2fa, modules: {code, name, description, available, enabled}[]}` |
|---|---|---|
| PATCH | /tenant | `{name?, tax_id?, require_2fa?}` (permiso `empresa.configurar`) |
| PUT | /tenant/modules/{code} | `{enabled}` (solo si `available`) |
| GET | /tenant/summary | → `{users, active_users, roles, modules_enabled: string[]}` |
| GET/PUT/DELETE | /tenant/email-config | SMTP propio (ver `EmailConfig` abajo); DELETE = usar el de la plataforma |
| POST | /tenant/email-config/test | `{to}` → 204 o error `EMAIL_TEST_FAILED` |
| GET | /audit | → `Page<{id, action, user_email, entity, entity_id, data, created_at}>` (permiso `auditoria.ver`) |

### Usuarios y roles
| GET | /users?search= | → `Page<{id, email, full_name, is_active, roles: {id, name}[], last_login_at, pending_invite}>` |
|---|---|---|
| POST | /users | `{email, full_name, role_ids}` → usuario (envía invitación) |
| PATCH | /users/{id} | `{full_name?, is_active?, role_ids?}` |
| POST | /users/{id}/resend-invite | → 204 |
| GET | /permissions | → `{code, area, name, module, scoped, available}[]` (`available` = su módulo está activo) |
| GET | /roles | → `{id, name, description, user_count, permissions: Record<string, Scope>, dashboard_layout: WidgetItem[]}[]` |
| POST | /roles | `{name, description, permissions, dashboard_layout}` |
| PATCH | /roles/{id} | mismos campos, opcionales |
| DELETE | /roles/{id} | 204 (409 si tiene usuarios) |

### Panel de Klyp (`/admin`, solo `platform_role`)
| GET | /admin/stats | → `{tenants: Record<status, number>, users, active_users_30d}` |
|---|---|---|
| GET | /admin/tenants?search=&status= | → `Page<{id, name, tax_id, status, plan_code, users, created_at, last_activity_at}>` |
| POST | /admin/tenants | `{name, tax_id?, admin_email, admin_name, status?}` → empresa (invita a su admin) |
| GET | /admin/tenants/{id} | → empresa + `modules` |
| PATCH | /admin/tenants/{id} | `{name?, tax_id?, status?, plan_code?, require_2fa?}` |
| PUT | /admin/tenants/{id}/modules/{code} | `{available, enabled?}` |
| POST | /admin/tenants/{id}/support | → `{access_token}` (modo soporte: usar este token, mostrar banda de aviso y botón «Salir del modo soporte» que restaura el token propio) |
| GET/PUT | /admin/email-config | `EmailConfig` |
| POST | /admin/email-config/test | `{to}` → 204 o `EMAIL_TEST_FAILED` |

`EmailConfig` = `{host, port, username, password?, has_password, use_tls, from_email, from_name}` (`password` solo se envía, nunca se devuelve).

Estados de empresa: `trial` (prueba), `active` (activa), `past_due` (impago), `disabled` (desactivada).
