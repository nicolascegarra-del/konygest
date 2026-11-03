"""Conexión a la base de datos y aislamiento por empresa.

Cada sesión lleva en `session.info` la empresa activa (`tenant_id`) y si puede
saltarse el aislamiento (`bypass_rls`, solo para el panel de plataforma y para
cargar al usuario autenticado). Al empezar cada transacción se copian a la
conexión con `set_config(..., true)`, y las políticas de Row Level Security de
PostgreSQL filtran todas las consultas con ellos. Así, aunque un servicio olvide
filtrar por empresa, la base de datos no devuelve filas de otra.
"""

from collections.abc import Callable, Iterator
from uuid import UUID

from sqlalchemy import event, text
from sqlalchemy.engine import Connection
from sqlmodel import Session, create_engine

from app.core.config import get_settings

settings = get_settings()

engine = create_engine(
    settings.database_app_url,
    pool_size=settings.database_pool_size,
    pool_pre_ping=True,
)


@event.listens_for(Session, "after_begin")
def _apply_tenant_context(session: Session, _transaction, connection: Connection) -> None:
    tenant_id = session.info.get("tenant_id")
    bypass = session.info.get("bypass_rls", False)
    connection.execute(
        text(
            "SELECT set_config('app.tenant_id', :tenant_id, true),"
            " set_config('app.bypass_rls', :bypass, true)"
        ),
        {"tenant_id": str(tenant_id) if tenant_id else "", "bypass": "on" if bypass else "off"},
    )


@event.listens_for(Session, "after_commit")
def _run_after_commit(session: Session) -> None:
    callbacks = session.info.pop("after_commit", [])
    for callback in callbacks:
        callback()


@event.listens_for(Session, "after_rollback")
def _drop_after_commit(session: Session) -> None:
    session.info.pop("after_commit", None)


def on_commit(session: Session, callback: Callable[[], None]) -> None:
    """Ejecuta `callback` solo si la transacción se confirma (emails, push…)."""
    session.info.setdefault("after_commit", []).append(callback)


def new_session(tenant_id: UUID | None = None, bypass_rls: bool = False) -> Session:
    session = Session(engine, expire_on_commit=False)
    session.info["tenant_id"] = tenant_id
    session.info["bypass_rls"] = bypass_rls
    return session


def system_session() -> Iterator[Session]:
    """Sesión sin aislamiento: login, tareas de sistema y panel de plataforma."""
    with new_session(bypass_rls=True) as session:
        yield session
