from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel, UniqueConstraint

from app.core.models import created_at_field, dt_field, id_field, tenant_fk


class PlatformRole(StrEnum):
    SUPERADMIN = "superadmin"
    SUPPORT = "support"


class User(SQLModel, table=True):
    """Usuario. Pertenece a una sola empresa, salvo el personal de Klyp
    (`platform_role`), que no tiene empresa."""

    __tablename__ = "app_user"

    id: UUID = id_field()
    tenant_id: UUID | None = tenant_fk(nullable=True)
    email: str = Field(max_length=254, unique=True, index=True)
    full_name: str = Field(max_length=200)
    password_hash: str | None = None
    is_active: bool = True
    platform_role: PlatformRole | None = None
    totp_secret_enc: str | None = None
    totp_enabled: bool = False
    failed_logins: int = 0
    locked_until: datetime | None = dt_field()
    last_login_at: datetime | None = dt_field()
    created_at: datetime = created_at_field()


class Role(SQLModel, table=True):
    __table_args__ = (UniqueConstraint("tenant_id", "name"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    name: str = Field(max_length=100)
    description: str = Field(default="", max_length=500)
    # Pantalla inicial por defecto del rol: [{"widget": "...", "size": "md"}]
    dashboard_layout: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = created_at_field()


class RolePermission(SQLModel, table=True):
    __tablename__ = "role_permission"
    __table_args__ = (UniqueConstraint("role_id", "permission"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    role_id: UUID = Field(foreign_key="role.id", index=True, ondelete="CASCADE")
    permission: str = Field(max_length=100)
    scope: str = Field(default="all", max_length=10)


class UserRole(SQLModel, table=True):
    __tablename__ = "user_role"
    __table_args__ = (UniqueConstraint("user_id", "role_id"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    user_id: UUID = Field(foreign_key="app_user.id", index=True, ondelete="CASCADE")
    role_id: UUID = Field(foreign_key="role.id", index=True, ondelete="CASCADE")


class UserDashboard(SQLModel, table=True):
    """Pantalla inicial personalizada. Si no existe, se usa la de su rol."""

    __tablename__ = "user_dashboard"

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    user_id: UUID = Field(foreign_key="app_user.id", unique=True, ondelete="CASCADE")
    layout: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
