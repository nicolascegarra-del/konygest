from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field

from app.modules.tenants.models import TenantStatus


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
    status: TenantStatus
    plan_code: str | None = None
    require_2fa: bool
    created_at: datetime | None = None
    last_activity_at: datetime | None = None
    modules: list[ModuleOut] = []


class TenantUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    tax_id: str | None = Field(default=None, max_length=20)
    require_2fa: bool | None = None


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
