from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import DateTime
from sqlmodel import Field

from app.core.security import utcnow


def id_field() -> UUID:
    return Field(default_factory=uuid4, primary_key=True)


def created_at_field() -> datetime:
    return Field(default_factory=utcnow, sa_type=DateTime(timezone=True), nullable=False)


def tenant_fk(nullable: bool = False) -> UUID:
    return Field(foreign_key="tenant.id", index=True, nullable=nullable, ondelete="CASCADE")


def dt_field(nullable: bool = True) -> datetime | None:
    return Field(default=None, sa_type=DateTime(timezone=True), nullable=nullable)
