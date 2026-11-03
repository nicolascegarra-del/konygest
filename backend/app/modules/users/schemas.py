from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field

ScopeLiteral = Literal["own", "all"]


class WidgetItem(BaseModel):
    widget: str
    size: Literal["sm", "md", "lg"] = "md"


class RoleRef(BaseModel):
    id: UUID
    name: str


class UserOut(BaseModel):
    id: UUID
    email: str
    full_name: str
    is_active: bool
    roles: list[RoleRef]
    last_login_at: datetime | None
    pending_invite: bool


class UserCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=200)
    role_ids: list[UUID] = Field(min_length=1)


class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    is_active: bool | None = None
    role_ids: list[UUID] | None = Field(default=None, min_length=1)


class PermissionOut(BaseModel):
    code: str
    area: str
    name: str
    module: str
    scoped: bool
    available: bool


class RoleOut(BaseModel):
    id: UUID
    name: str
    description: str
    user_count: int
    permissions: dict[str, ScopeLiteral]
    dashboard_layout: list[WidgetItem]


class RoleIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=500)
    permissions: dict[str, ScopeLiteral] = {}
    dashboard_layout: list[WidgetItem] = []


class RoleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    permissions: dict[str, ScopeLiteral] | None = None
    dashboard_layout: list[WidgetItem] | None = None


class WidgetCatalogItem(BaseModel):
    code: str
    name: str
    description: str


class DashboardOut(BaseModel):
    layout: list[WidgetItem]
    customized: bool
    catalog: list[WidgetCatalogItem]


class DashboardIn(BaseModel):
    layout: list[WidgetItem] = Field(max_length=30)
