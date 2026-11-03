#!/bin/sh
# Crea el rol con el que se conecta la API y la base de datos de tests.
# La API no es dueña de las tablas, así que la Row Level Security se le aplica
# siempre (el dueño, que es quien migra, se la saltaría). Los permisos sobre
# las tablas los concede cada migración de Alembic.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE konygest_app LOGIN PASSWORD '${APP_DB_PASSWORD}';
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO konygest_app;
  CREATE DATABASE ${POSTGRES_DB}_test OWNER ${POSTGRES_USER};
  GRANT CONNECT ON DATABASE ${POSTGRES_DB}_test TO konygest_app;
EOSQL
