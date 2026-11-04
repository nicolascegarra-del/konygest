from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, StringConstraints, field_validator

from app.modules.tenants.models import TenantStatus


def _text(max_length: int):
    return Annotated[str, StringConstraints(strip_whitespace=True, max_length=max_length)]


_Text10 = _text(10)
_Text50 = _text(50)
_Text100 = _text(100)
_Text200 = _text(200)
_Text300 = _text(300)
FISCAL_FIELDS = ("legal_name", "address", "postal_code", "city", "province", "feed_registration")


class ModuleOut(BaseModel):
    code: str
    name: str
    description: str
    available: bool
    enabled: bool


class TenantOut(BaseModel):
    id: UUID
    name: str
    tax_id: str | None
    # Datos fiscales que salen en facturas y albaranes (fase 4)
    legal_name: str = ""
    address: str = ""
    postal_code: str = ""
    city: str = ""
    province: str = ""
    feed_registration: str = ""
    status: TenantStatus
    plan_code: str | None = None
    require_2fa: bool
    created_at: datetime | None = None
    last_activity_at: datetime | None = None
    modules: list[ModuleOut] = []


class TenantUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    tax_id: str | None = Field(default=None, max_length=20)
    legal_name: _Text200 | None = None
    address: _Text300 | None = None
    postal_code: _Text10 | None = None
    city: _Text100 | None = None
    province: _Text100 | None = None
    # Nº de registro del establecimiento de piensos (p. ej. αES30001234)
    feed_registration: _Text50 | None = None
    require_2fa: bool | None = None

    @field_validator(*FISCAL_FIELDS)
    @classmethod
    def _null_as_empty(cls, value: str | None) -> str:
        # Las columnas no admiten nulos: «null» borra el dato
        return value or ""


class ModuleToggle(BaseModel):
    enabled: bool


class TenantSummary(BaseModel):
    users: int
    active_users: int
    roles: int
    modules_enabled: list[str]


class AdminTenantRow(BaseModel):
    id: UUID
    name: str
    tax_id: str | None
    status: TenantStatus
    plan_code: str | None
    users: int
    created_at: datetime
    last_activity_at: datetime | None


class AdminTenantCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    tax_id: str | None = Field(default=None, max_length=20)
    admin_email: EmailStr
    admin_name: str = Field(min_length=1, max_length=200)
    status: TenantStatus = TenantStatus.TRIAL


class AdminTenantUpdate(TenantUpdate):
    status: TenantStatus | None = None
    plan_code: str | None = Field(default=None, max_length=50)


class AdminModuleUpdate(BaseModel):
    available: bool
    enabled: bool | None = None
