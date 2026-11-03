from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import JSON, Column, Index
from sqlmodel import Field, SQLModel

from app.core.models import created_at_field, id_field, tenant_fk


class EmailConfig(SQLModel, table=True):
    """Servidor de correo. Sin empresa = el global de la plataforma."""

    __tablename__ = "email_config"

    id: UUID = id_field()
    tenant_id: UUID | None = tenant_fk(nullable=True)
    host: str = Field(max_length=200)
    port: int = 587
    username: str = Field(default="", max_length=200)
    password_enc: str | None = None
    use_tls: bool = True
    from_email: str = Field(max_length=254)
    from_name: str = Field(default="Konygest", max_length=100)


class AuditLog(SQLModel, table=True):
    __table_args__ = (Index("ix_audit_log_tenant_created", "tenant_id", "created_at"),)

    __tablename__ = "audit_log"

    id: UUID = id_field()
    tenant_id: UUID | None = tenant_fk(nullable=True)
    user_id: UUID | None = Field(default=None, index=True)
    action: str = Field(max_length=100, index=True)
    entity: str = Field(default="", max_length=50)
    entity_id: str | None = Field(default=None, max_length=50)
    data: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = created_at_field()
