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

> ⚠️ `ENCRYPTION_KEY` cifra las contraseñas SMTP, los secretos 2FA y las credenciales de los
> destinos de documentos (tokens de Google/Microsoft y contraseñas SMB). Si se pierde o
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

## 6. Almacenamiento de ficheros (albaranes)
Los albaranes en PDF se guardan al registrar cada carga y se sirven después desde el
almacenamiento; no se pueden regenerar idénticos, así que **hay que conservarlos**.

- **Por defecto (`STORAGE_BACKEND=local`)**: carpeta `/app/storage` de la API, montada en el
  volumen nombrado `storage` de `docker-compose.prod.yml` (compartido con el worker). Sobrevive a
  los despliegues. Las claves tienen la forma `<id empresa>/Albaranes/2026/ALB-2026-0001.pdf` (`Ordenes-de-carga`
  para las órdenes de carga); cada fichero queda registrado en la tabla `stored_document`.
- **Copia de seguridad**: incluye el volumen en el plan de backups del VPS junto con PostgreSQL.
  Por ejemplo, desde el servidor (el nombre real del volumen lleva el prefijo del recurso de
  Coolify: `docker volume ls | grep storage`):
  ```sh
  docker run --rm -v <recurso>_storage:/data:ro -v /root/backups:/backup alpine     tar czf /backup/konygest-storage-$(date +%F).tar.gz -C /data .
  ```
- **MinIO / S3**: para guardar fuera del VPS (o en varios servidores), define en Coolify
  `STORAGE_BACKEND=s3`, `MINIO_ENDPOINT` (`host:puerto`, sin `https://`), `MINIO_ACCESS_KEY`,
  `MINIO_SECRET_KEY`, `MINIO_BUCKET_NAME` (se crea si no existe) y `MINIO_SECURE=true` si va por
  HTTPS. Sirve un MinIO desplegado como servicio aparte en Coolify o cualquier S3 compatible.
  Antes de cambiar, copia los ficheros existentes al bucket con la misma estructura de claves
  (p. ej. `mc mirror /ruta/del/volumen minio/konygest`).
- La imagen de la API ya incluye las librerías nativas de WeasyPrint (Pango, HarfBuzz y fuentes
  DejaVu). Si un PDF no puede generarse, la API responde 503 `PDF_UNAVAILABLE`.

## 7. Destinos de documentos (Google Drive y OneDrive)
Cada empresa elige en **Ajustes › Documentos** dónde se guardan sus documentos
(`docs/api-documentos.md`). La carpeta de red (SMB) y el almacenamiento de Konygest funcionan sin
configurar nada; los botones «Conectar con Google» y «Conectar con Microsoft» solo aparecen si la
plataforma tiene registrada su app en cada proveedor. Una sola app de Klyp sirve para todas las
empresas.

URI de redirección (sustituye el dominio por tu `APP_URL`, exacta, sin barra final):
- Google: `https://konygest.tudominio.es/api/v1/tenant/storage/oauth/google_drive/callback`
- Microsoft: `https://konygest.tudominio.es/api/v1/tenant/storage/oauth/onedrive/callback`

### Google Cloud Console
1. <https://console.cloud.google.com/> → crea un proyecto (p. ej. «Konygest»).
2. **APIs y servicios › Biblioteca** → busca **Google Drive API** → **Habilitar**.
3. **APIs y servicios › Pantalla de consentimiento de OAuth** (Google Auth Platform):
   - Tipo de usuario **Externo** (las empresas usan sus propias cuentas).
   - Nombre «Konygest», email de asistencia, logotipo opcional, dominio de la app
     (`konygest.tudominio.es`), enlaces a la política de privacidad y condiciones, y el
     **dominio autorizado** `tudominio.es`.
   - **Permisos (ámbitos)**: añade `.../auth/drive.file`, `openid` y `.../auth/userinfo.email`.
     `drive.file` es un ámbito *no sensible*: Konygest solo ve los ficheros y carpetas que crea.
   - Mientras esté en **Prueba**, solo pueden conectar los usuarios de prueba que añadas y los
     tokens caducan a los 7 días. Para producción, **Publicar la app** (con `drive.file` no hace
     falta la verificación de seguridad de Google, como mucho la verificación de marca).
4. **APIs y servicios › Credenciales › Crear credenciales › ID de cliente de OAuth**:
   - Tipo **Aplicación web**, nombre «Konygest».
   - **URI de redirección autorizados**: la de Google de arriba (y la de staging si la hay).
   - Copia el **ID de cliente** y el **Secreto de cliente**.
5. En Coolify: `GOOGLE_OAUTH_CLIENT_ID` y `GOOGLE_OAUTH_CLIENT_SECRET`.

### Microsoft Entra (OneDrive y SharePoint)
1. <https://entra.microsoft.com/> → **Identidad › Aplicaciones › Registros de aplicaciones ›
   Nuevo registro**.
   - Nombre «Konygest».
   - Tipos de cuenta: **Cuentas en cualquier directorio organizativo y cuentas personales de
     Microsoft** (para OneDrive de empresa y personal). Si solo vas a admitir cuentas de trabajo,
     elige «cualquier directorio organizativo» y pon `MICROSOFT_OAUTH_TENANT=organizations`.
   - **URI de redirección**: plataforma **Web**, la de Microsoft de arriba.
2. En la app: **Certificados y secretos › Nuevo secreto de cliente** → copia el **Valor** (solo
   se ve una vez). Apunta la fecha de caducidad (máx. 24 meses) y renuévalo antes.
3. **Permisos de API › Agregar un permiso › Microsoft Graph › Permisos delegados**:
   `offline_access`, `User.Read`, `Files.ReadWrite` y, para bibliotecas de SharePoint,
   `Sites.ReadWrite.All`. No hacen falta permisos de aplicación. Algunas organizaciones exigen que
   su administrador dé el consentimiento: lo pedirá Microsoft al conectar.
4. **Información general**: copia el **Id. de aplicación (cliente)**.
5. En Coolify: `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET` y
   `MICROSOFT_OAUTH_TENANT` (`common` por defecto).

### Variables en Coolify
| Variable | Valor |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | credenciales OAuth de Google (vacías = no se ofrece Google Drive) |
| `MICROSOFT_OAUTH_CLIENT_ID` / `MICROSOFT_OAUTH_CLIENT_SECRET` | app de Microsoft Entra (vacías = no se ofrece OneDrive) |
| `MICROSOFT_OAUTH_TENANT` | `common` (def.), `organizations` o el id de un directorio concreto |

Tras cambiarlas, **Redeploy**. Comprobación: en Ajustes › Documentos aparecen los botones, al
conectar se vuelve a Konygest con la cuenta conectada y «Probar conexión» responde bien.

Carpetas SMB: el contenedor de la API tiene que llegar al puerto 445 del NAS (IP pública
restringida, VPN o Tailscale en el VPS). Si un destino falla al guardar, el documento se guarda en
el almacenamiento de Konygest (sección 6) y se avisa a quien configura la empresa.

## Comprobación tras el despliegue
- `https://konygest.tudominio.es/` carga la landing (HTTP 200).
- Login del superadmin y acceso a `/admin`.
- `/admin/email` → «Enviar prueba» llega al buzón.
- Logs de `api` y `worker` sin errores (`celery@… ready.` en el worker).
- Una orden de carga se descarga en PDF desde Logística (comprueba WeasyPrint).
