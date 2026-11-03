from datetime import datetime
from uuid import UUID

from sqlmodel import Field, SQLModel, UniqueConstraint

from app.core.models import created_at_field, dt_field, id_field, tenant_fk


class Notification(SQLModel, table=True):
    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    user_id: UUID = Field(foreign_key="app_user.id", index=True, ondelete="CASCADE")
    type: str = Field(max_length=50)
    title: str = Field(max_length=200)
    body: str = Field(default="", max_length=1000)
    link: str | None = Field(default=None, max_length=300)
    read_at: datetime | None = dt_field()
    created_at: datetime = created_at_field()


class TenantNotificationSetting(SQLModel, table=True):
    """Canales permitidos (y activos por defecto) de cada tipo de aviso en una empresa."""

    __tablename__ = "tenant_notification_setting"
    __table_args__ = (UniqueConstraint("tenant_id", "type"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    type: str = Field(max_length=50)
    in_app: bool = True
    email: bool = False
    push: bool = False


class UserNotificationPreference(SQLModel, table=True):
    """Lo que el usuario quiere recibir, dentro de lo que permite su empresa."""

    __tablename__ = "user_notification_preference"
    __table_args__ = (UniqueConstraint("user_id", "type"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    user_id: UUID = Field(foreign_key="app_user.id", index=True, ondelete="CASCADE")
    type: str = Field(max_length=50)
    in_app: bool = True
    email: bool = True
    push: bool = True


class PushSubscription(SQLModel, table=True):
    __tablename__ = "push_subscription"

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    user_id: UUID = Field(foreign_key="app_user.id", index=True, ondelete="CASCADE")
    endpoint: str = Field(max_length=500, unique=True)
    p256dh: str = Field(max_length=200)
    auth: str = Field(max_length=100)
    created_at: datetime = created_at_field()
