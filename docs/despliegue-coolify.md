# Despliegue en Coolify

Konygest se despliega como un recurso **Docker Compose** de Coolify con el fichero
`docker-compose.prod.yml`. Solo el servicio `web` tiene dominio; la API, el worker,
PostgreSQL y Redis quedan en la red interna, sin puertos públicos.

```
Internet ─► Proxy de Coolify (SSL) ─► web:3000 (Next.js) ──/api/v1──► api:8000 (FastAPI)
                                                                     ├─► db (PostgreSQL 16)
                                                         worker ─────┴─► redis (colas, límites)
```

## 1. Crear el recurso
1. En el proyecto, **+ New → Public/Private Repository** con `nicolascegarra-del/konygest`, rama `v1`.
2. **Build Pack: Docker Compose**.
3. **Docker Compose Location**: `/docker-compose.prod.yml`.

## 2. Variables de entorno
En **Environment Variables**, como mínimo (genera cada secreto aparte):

| Variable | Valor |
|---|---|
| `APP_URL` | `https://konygest.tudominio.es` (la URL pública, sin barra final) |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `APP_DB_PASSWORD` | `openssl rand -hex 24` (rol de la API) |
| `JWT_SECRET_KEY` | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `BOOTSTRAP_SUPERADMIN_EMAIL` | tu email de Klyp |
| `BOOTSTRAP_SUPERADMIN_PASSWORD` | contraseña inicial (cámbiala tras entrar) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_USE_TLS`, `EMAIL_FROM` | tu servidor de correo. También se puede configurar después desde `/admin/email`. |

Opcionales: `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (push; `npx web-push generate-vapid-keys`),
`POSTGRES_USER`, `POSTGRES_DB`, `JWT_*_EXPIRE_*`.

> ⚠️ `ENCRYPTION_KEY` cifra las contraseñas SMTP y los secretos 2FA guardados. Si se pierde o
> se cambia, habrá que volver a configurarlos. Guárdala en el gestor de contraseñas.

## 3. Dominio
En **Domains**, servicio **`web`**: `https://konygest.tudominio.es:3000`
(el `:3000` indica a Coolify el puerto del contenedor; el público será el 443).
No pongas dominio a `api`, `worker`, `db` ni `redis`.

En tu DNS: registro **A** de `konygest.tudominio.es` → IP del VPS. Coolify emite el
certificado de Let's Encrypt al desplegar.

## 4. Desplegar
Pulsa **Deploy**. En el arranque, la API:
1. crea o actualiza el rol `konygest_app` de PostgreSQL (`python -m app.db_setup`),
2. aplica las migraciones (`alembic upgrade head`),
3. crea el superadmin si no existe ninguno (`python -m app.bootstrap`).

Después entra en `https://konygest.tudominio.es/login` con el superadmin. Te pedirá
activar la verificación en dos pasos antes de abrir el panel `/admin`.

## 5. Antes de cada despliegue con migraciones
- Copia de seguridad de PostgreSQL (Coolify → recurso `db` → Backups, o `pg_dump`).
- Prueba la migración en staging primero.

## Comprobación tras el despliegue
- `https://konygest.tudominio.es/` carga la landing (HTTP 200).
- Login del superadmin y acceso a `/admin`.
- `/admin/email` → «Enviar prueba» llega al buzón.
- Logs de `api` y `worker` sin errores (`celery@… ready.` en el worker).
