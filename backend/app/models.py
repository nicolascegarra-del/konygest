"""Importa todos los modelos para que Alembic y SQLModel los registren."""

from app.core.sequence import DocumentSequence
from app.modules.auth.models import ActionToken, AuthSession
from app.modules.masters.models import (
    Carrier,
    Customer,
    CustomerPrice,
    Driver,
    Farm,
    Item,
    PaymentMethod,
    PriceList,
    PriceListLine,
    Silo,
    Truck,
    VatRate,
)
from app.modules.notifications.models import (
    Notification,
    PushSubscription,
    TenantNotificationSetting,
    UserNotificationPreference,
)
from app.modules.platform.models import AuditLog, EmailConfig
from app.modules.production.models import ProductionOrder
from app.modules.stock.models import RawMaterialReceipt, StockMovement
from app.modules.tenants.models import Tenant, TenantModule
from app.modules.users.models import Role, RolePermission, User, UserDashboard, UserRole

__all__ = [
    "ActionToken",
    "AuditLog",
    "AuthSession",
    "Carrier",
    "Customer",
    "CustomerPrice",
    "DocumentSequence",
    "Driver",
    "EmailConfig",
    "Farm",
    "Item",
    "PaymentMethod",
    "PriceList",
    "PriceListLine",
    "ProductionOrder",
    "RawMaterialReceipt",
    "Notification",
    "PushSubscription",
    "Role",
    "RolePermission",
    "Silo",
    "StockMovement",
    "Tenant",
    "TenantModule",
    "TenantNotificationSetting",
    "Truck",
    "User",
    "UserDashboard",
    "UserNotificationPreference",
    "UserRole",
    "VatRate",
]
