from datetime import datetime
from enum import StrEnum
from uuid import UUID

from sqlmodel import Field, SQLModel

from app.core.models import created_at_field, dt_field, id_field


class AuthSession(SQLModel, table=True):
    """Sesión abierta: guarda el hash del refresh token, que rota en cada uso."""

    __tablename__ = "auth_session"

    id: UUID = id_field()
    user_id: UUID = Field(foreign_key="app_user.id", index=True, ondelete="CASCADE")
    token_hash: str = Field(max_length=64, unique=True)
    expires_at: datetime = dt_field(nullable=False)  # type: ignore[assignment]
    revoked_at: datetime | None = dt_field()
    user_agent: str = Field(default="", max_length=300)
    created_at: datetime = created_at_field()
    last_used_at: datetime | None = dt_field()


class ActionPurpose(StrEnum):
    INVITE = "invite"
    RESET_PASSWORD = "reset_password"  # noqa: S105


class ActionToken(SQLModel, table=True):
    """Enlace de un solo uso enviado por email (invitación o recuperación)."""

    __tablename__ = "action_token"

    id: UUID = id_field()
    user_id: UUID = Field(foreign_key="app_user.id", index=True, ondelete="CASCADE")
    purpose: ActionPurpose
    token_hash: str = Field(max_length=64, unique=True)
    expires_at: datetime = dt_field(nullable=False)  # type: ignore[assignment]
    used_at: datetime | None = dt_field()
    created_at: datetime = created_at_field()
