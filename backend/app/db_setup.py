"""Crea o actualiza el rol `konygest_app` con el que se conecta la API.

En desarrollo lo hace `docker/postgres/init.sh`; en producción (Coolify) no se
monta ese script, así que el contenedor de la API ejecuta esto antes de migrar:
`python -m app.db_setup`. Usa DATABASE_URL (dueño de la base de datos) y la
contraseña de APP_DB_PASSWORD. Es idempotente.
"""

import logging
import os

import psycopg
from psycopg import sql
from sqlalchemy.engine import make_url

from app.core.config import get_settings

logger = logging.getLogger("konygest.db_setup")
APP_ROLE = "konygest_app"


def main() -> None:
    password = os.environ.get("APP_DB_PASSWORD", "")
    if not password:
        logger.info("Sin APP_DB_PASSWORD: no se toca el rol %s.", APP_ROLE)
        return
    url = make_url(get_settings().database_url)
    with psycopg.connect(
        host=url.host,
        port=url.port or 5432,
        user=url.username,
        password=url.password,
        dbname=url.database,
        autocommit=True,
    ) as conn:
        exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (APP_ROLE,)).fetchone()
        verb = "ALTER" if exists else "CREATE"
        conn.execute(
            sql.SQL("{} ROLE {} LOGIN PASSWORD {}").format(
                sql.SQL(verb), sql.Identifier(APP_ROLE), sql.Literal(password)
            )
        )
        conn.execute(
            sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
                sql.Identifier(url.database or ""), sql.Identifier(APP_ROLE)
            )
        )
    logger.info("Rol %s preparado.", APP_ROLE)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
