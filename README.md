# Konygest
Gestión integral para fábricas de piensos a granel: stock, fabricación, pedidos de comerciales, logística y cargas, facturación con Verifactu y asistente de IA. SaaS multi-empresa de Klyp.

El plan completo está en [docs/plan.md](docs/plan.md).

## Requisitos previos
- Docker y Docker Compose
- Python 3.12+ (backend) y Node.js 22+ (frontend) para desarrollo sin contenedores

## Instalación y arranque local
```bash
cp .env.example .env          # y rellena los secretos (ver comentarios)
docker compose up -d db redis mailpit
cd backend && uv sync
uv run alembic upgrade head
uv run python -m app.bootstrap   # crea el superadmin de BOOTSTRAP_SUPERADMIN_*
uv run uvicorn app.main:app --reload
```
- API: http://localhost:8000 · documentación en http://localhost:8000/docs
- Correos de desarrollo (Mailpit): http://localhost:8025
- PostgreSQL escucha en el puerto **5433** del equipo.

O todo con Docker: `docker compose up --build`.

## Variables de entorno necesarias
Todas están documentadas en `.env.example`. La API usa dos usuarios de base de datos:
`DATABASE_URL` (dueño, solo migraciones) y `DATABASE_APP_URL` (rol `konygest_app`,
sujeto a Row Level Security para aislar las empresas).

## Estructura del proyecto
```
backend/    FastAPI + SQLModel + PostgreSQL
frontend/   Next.js 15 + Tailwind + shadcn/ui
docs/       Plan y documentación
```

## Comandos útiles (test, lint, build, migrate)
```bash
cd backend
uv run pytest --cov=app           # tests contra la BD konygest_test (necesita `db` levantado)
uv run ruff check app tests && uv run ruff format --check app tests
uv run alembic revision --autogenerate -m "descripcion"
uv run alembic upgrade head
```
Contrato de la API de la fase 0: [docs/api-fase0.md](docs/api-fase0.md).

## Deploy
Coolify sobre VPS Contabo.

## Contacto / equipo
Klyp
