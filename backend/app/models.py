"""Importa todos los modelos para que Alembic y SQLModel los registren."""

from app.modules.auth.models import ActionToken, AuthSession
from app.modules.notifications.models import (
    Notification,
    PushSubscription,
    TenantNotificationSetting,
    UserNotificationPreference,
)
from app.modules.platform.models import AuditLog, EmailConfig
from app.modules.tenants.models import Tenant, TenantModule
from app.modules.users.models import Role, RolePermission, User, UserDashboard, UserRole

__all__ = [
    "ActionToken",
    "AuditLog",
    "AuthSession",
    "EmailConfig",
    "Notification",
    "PushSubscription",
    "Role",
    "RolePermission",
    "Tenant",
    "TenantModule",
    "TenantNotificationSetting",
    "User",
    "UserDashboard",
    "UserNotificationPreference",
    "UserRole",
]
