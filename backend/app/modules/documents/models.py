"""Destino de los documentos de cada empresa y registro de los documentos guardados."""

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import JSON, Column, Index
from sqlmodel import Field, SQLModel

from app.core.models import created_at_field, dt_field, id_field, tenant_fk


class TenantStorage(SQLModel, table=True):
    """Configuración del destino de documentos de una empresa (una fila como mucho).

    Los ajustes y los secretos se guardan **por proveedor** (`{"smb": {...}, "google_drive":
    {...}}`): así, al cambiar de destino, los documentos antiguos se siguen pudiendo leer del
    proveedor donde se guardaron, y una cuenta de Google o Microsoft se puede conectar antes de
    activarla. `secrets_enc` es un JSON `{proveedor: secreto}` cifrado con `ENCRYPTION_KEY`
    (refresh token de OAuth o contraseña SMB) y nunca sale al cliente.
    """

    __tablename__ = "tenant_storage"

    id: UUID = id_field()
    tenant_id: UUID = Field(foreign_key="tenant.id", unique=True, ondelete="CASCADE")
    provider: str = Field(default="platform", max_length=20)  # destino activo
    provider_settings: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    secrets_enc: str | None = None
    # Cuenta conectada por proveedor OAuth: {"google_drive": "oficina@empresa.es"}
    accounts: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = Field(default="ok", max_length=20)  # ok | error
    last_error: str | None = Field(default=None, max_length=500)
    last_checked_at: datetime | None = dt_field()
    # Último aviso `documentos_error` (como mucho uno al día)
    last_alert_at: datetime | None = dt_field()
    updated_at: datetime = created_at_field()
    updated_by: UUID | None = Field(default=None, foreign_key="app_user.id", ondelete="SET NULL")


class StoredDocument(SQLModel, table=True):
    """Un fichero guardado: dónde está y de qué datos sale (para regenerarlo si falta)."""

    __tablename__ = "stored_document"
    __table_args__ = (
        Index("ux_stored_document_tenant_kind_number", "tenant_id", "kind", "number", unique=True),
        Index("ix_stored_document_tenant_created", "tenant_id", "created_at"),
    )

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    kind: str = Field(max_length=30)  # delivery_note, loading_order, invoice…
    number: str = Field(max_length=50)
    filename: str = Field(max_length=200)
    content_type: str = Field(default="application/pdf", max_length=100)
    # Dónde se guardó (no cambia aunque la empresa cambie de destino)
    provider: str = Field(max_length=20)
    location: str = Field(max_length=1000)
    size: int = 0
    sha256: str = Field(default="", max_length=64)
    source_type: str | None = Field(default=None, max_length=30)
    source_id: UUID | None = None
    created_at: datetime = created_at_field()
    updated_at: datetime = created_at_field()
