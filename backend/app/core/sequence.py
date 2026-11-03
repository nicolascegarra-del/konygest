"""Numeración correlativa de documentos por empresa, serie y año (OF-2026-0001)."""

from uuid import UUID

from sqlalchemy import text
from sqlmodel import Field, Session, SQLModel, UniqueConstraint

from app.core.models import id_field, tenant_fk


class DocumentSequence(SQLModel, table=True):
    __tablename__ = "document_sequence"
    __table_args__ = (UniqueConstraint("tenant_id", "series", "year"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    series: str = Field(max_length=20)
    year: int
    last: int = 0


def next_number(session: Session, tenant_id: UUID, series: str, year: int) -> str:
    """Reserva el siguiente número de la serie.

    El upsert bloquea la fila hasta el commit, así que dos peticiones simultáneas
    nunca obtienen el mismo número y, si la transacción se deshace, el número no
    se consume.
    """
    last = session.execute(
        text(
            "INSERT INTO document_sequence (id, tenant_id, series, year, last)"
            " VALUES (gen_random_uuid(), :tenant_id, :series, :year, 1)"
            " ON CONFLICT (tenant_id, series, year)"
            " DO UPDATE SET last = document_sequence.last + 1"
            " RETURNING last"
        ),
        {"tenant_id": tenant_id, "series": series, "year": year},
    ).scalar_one()
    return f"{series}-{year}-{last:04d}"
