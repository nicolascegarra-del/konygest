FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    STORAGE_LOCAL_PATH=/app/storage

# Librerías nativas de WeasyPrint (PDF): Pango/HarfBuzz para maquetar texto y una
# fuente sans-serif del sistema (las plantillas no cargan fuentes remotas)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11.11 /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY . .

# /app/storage: ficheros del backend local (en producción se monta un volumen encima)
RUN useradd --create-home --uid 1000 konygest \
    && mkdir -p /app/storage \
    && chown -R konygest /app
USER konygest

EXPOSE 8000
CMD ["gunicorn", "app.main:app", "-k", "uvicorn.workers.UvicornWorker", "-w", "2", "-b", "0.0.0.0:8000"]
