from datetime import datetime
from enum import StrEnum
from uuid import UUID

from sqlmodel import Field, SQLModel, UniqueConstraint

from app.core.models import created_at_field, dt_field, id_field, tenant_fk


class TenantStatus(StrEnum):
    TRIAL = "trial"
    ACTIVE = "active"
    PAST_DUE = "past_due"
    DISABLED = "disabled"


class Tenant(SQLModel, table=True):
    id: UUID = id_field()
    name: str = Field(max_length=200)
    tax_id: str | None = Field(default=None, max_length=20)
    status: TenantStatus = Field(default=TenantStatus.TRIAL, index=True)
    plan_code: str | None = Field(default=None, max_length=50)
    require_2fa: bool = False
    created_at: datetime = created_at_field()
    last_activity_at: datetime | None = dt_field()


class TenantModule(SQLModel, table=True):
    """Módulo opcional de una empresa.

    `available` lo decide Klyp (plan contratado); `enabled` lo decide la empresa
    entre los disponibles.
    """

    __tablename__ = "tenant_module"
    __table_args__ = (UniqueConstraint("tenant_id", "module_code"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    module_code: str = Field(max_length=50)
    available: bool = False
    enabled: bool = False
