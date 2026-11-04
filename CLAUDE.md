# Konygest — contexto del proyecto para Claude

Gestión integral para fábricas de piensos a granel (SaaS multi-empresa de Klyp). Amplía los
estándares globales de Klyp (`~/.claude/CLAUDE.md`); en caso de conflicto manda este fichero.

- Plan completo y decisiones de producto: [docs/plan.md](docs/plan.md).
- Contrato de la API de cada fase (fuente de verdad entre backend y frontend):
  `docs/api-fase0.md`, `api-fase1.md`, `api-fase2.md`, `api-fase3.md`…
- Despliegue: [docs/despliegue-coolify.md](docs/despliegue-coolify.md).

## Estado de las fases

Mantén esta tabla al día al cerrar cada fase.

| Fase | Contenido | Estado |
|---|---|---|
| 0 | Cimientos: login, empresas, usuarios, roles configurables, RLS, panel de Klyp `/admin`, pantalla inicial configurable, avisos | ✅ en `v1` |
| 0b | Landing pública | ✅ en `v1` |
| 1 | Maestros, stock (libro inmutable), entradas de MP con báscula, fabricación de producto terminado | ✅ en `v1` |
| 2 | Pedidos de comerciales con validación en oficina (riesgo, precio, stock) | ✅ en `v1` |
| 3 | Logística: cargas, compartimentos, orden de carga, pesada, albarán PDF; módulo de documentos (storage + WeasyPrint) y destino de documentos por empresa (Google Drive, OneDrive/SharePoint, SMB; contrato en `docs/api-documentos.md`) | ✅ en `v1` |
| 4 | Facturación, abonos y registro Verifactu (sin envío) | 🔄 núcleo de huella y QR hecho en `backend/app/modules/verifactu/` (puntos `VERIFICAR` pendientes) |
| 5 | Fórmulas y lotes con trazabilidad | pendiente |
| 6 | IA (clave por empresa, asistente, pedidos por voz, propuesta de cargas) | pendiente |
| 7 | Conector ERP y envío Verifactu a la AEAT | pendiente |
| 8 | Suscripción SaaS | pendiente |
| 9 | Mantenimiento de planta y flota | pendiente |
| 10 | CRM del comercial | pendiente |

Pendiente fuera de las fases:
- Coolify no tiene auto-deploy (falta webhook o GitHub App); se despliega a mano con **Deploy**,
  previa copia de seguridad de PostgreSQL cuando hay migraciones.
- Los botones «Conectar con Google / Microsoft» necesitan registrar la app una vez en Google Cloud
  y Microsoft Entra y poner sus credenciales OAuth en Coolify (pasos en la guía de despliegue).
- Destino de documentos: el elegido por la empresa es el almacén principal (decisión del usuario);
  los documentos se registran en `stored_document` y se regeneran desde la BD si faltan.
- En producción solo existe el superadmin del bootstrap (`BOOTSTRAP_SUPERADMIN_*` en Coolify); los
  datos y usuarios de demostración solo están en las bases de datos locales.

## Cómo se trabaja en este proyecto

- **Por fase**: rama `feature/faseN-...` desde `v1`. Primero se escriben los modelos, la migración
  (con RLS), el catálogo (permisos, widgets, avisos) y el contrato `docs/api-faseN.md`; después
  backend y frontend se construyen **en paralelo con subagentes** contra ese contrato (el usuario
  pide paralelizar siempre que se pueda), y al final se integra, se pasa la suite completa y se
  prueba en el navegador (también a 375 px y con varios roles).
- **Commits** en castellano con Conventional Commits, varios por fase (modelos/migración, backend,
  docs+seed, frontend…). Al cerrar la fase el usuario suele pedir **fast-forward de `v1` y push**
  directamente (sin PR). `v1` es la rama por defecto y la que despliega Coolify.
- **CI** (`.github/workflows/ci.yml`): ruff + pytest contra PostgreSQL real con el rol
  `konygest_app` (cobertura ≥ 70 %), y eslint + tsc + vitest + build del frontend.

## Convenciones del código

- Backend en `backend/app/modules/<dominio>/` con `models.py`, `schemas.py`, `service.py`,
  `router.py`. Maestros con CRUD genérico (`masters/crud.py`, `MasterSpec`).
- **Multi-empresa**: `tenant_id` en todas las tablas + Row Level Security. La API usa el rol
  `konygest_app` (no dueño de las tablas); cada migración concede permisos y crea la política
  `tenant_isolation`. `stock_movement` es solo SELECT/INSERT (libro inmutable).
- Errores estándar Klyp `{"error": {code, message, field?, request_id}}`; 409 `INVALID_STATUS` para
  transiciones no válidas, 403 si la acción existe pero no para ese usuario, 404 fuera de alcance.
  Las fichas devuelven `allowed_actions` y el frontend se guía solo por ellas.
- Cantidades en kg y precios en €/kg: `Decimal` en BD, número en JSON (`app/core/numbers.py`).
  «Hoy» se calcula en `Europe/Madrid`. Numeración correlativa con `app/core/sequence.py`
  (`PED-`, `OF-`, `EMP-`, `CAR-`, `ALB-`…).
- Alcance «propios» (Comercial): ve sus clientes y los pedidos suyos o de sus clientes.
- Los índices que no salen de los modelos se declaran en `__table_args__` para que
  `alembic revision --autogenerate` no proponga borrarlos.
- Frontend: Next.js 15 App Router, componentes en `src/components/<dominio>/`, tipos por fase en
  `src/types/faseN.ts`, widgets registrados en `src/components/dashboard/registry.tsx` con el mismo
  código que `app/core/catalog.py`.

## Entorno de desarrollo (Windows del usuario)

- PostgreSQL en Docker (`docker compose up -d db redis mailpit`), puerto **5433**.
- `uvicorn.exe` está bloqueado por una directiva de Windows: usar
  `uv run python -m uvicorn app.main:app --port 8001`.
- No hay Node en el PATH: el frontend se valida y se sirve con Docker (`node:22-alpine` montando
  `frontend/`), p. ej.
  `MSYS_NO_PATHCONV=1 docker run --rm -v "C:\\dev\\konygest\\frontend:/app" -w /app node:22-alpine sh -c "npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run"`.
- WeasyPrint no carga en Windows sin GTK: los PDF se generan en Docker, CI y producción; en local
  los tests de PDF se saltan y la API responde 503 `PDF_UNAVAILABLE`.
- Si varios agentes ejecutan tests a la vez, cada uno usa su propia BD de test
  (`TEST_DATABASE_URL` / `TEST_DATABASE_APP_URL`, que `tests/conftest.py` admite) para no
  chocar en el truncado y las migraciones de `konygest_test`.
- Datos de demostración locales: `uv run python -m app.seed_demo <contraseña>` (empresa
  «Piensos Demo» con maestros, stock, fabricación, pedidos y cargas). Hay además usuarios de
  prueba `prueba-<rol>@demo.konygest.es` creados a mano en la BD local (la contraseña no se
  guarda en el repo).
