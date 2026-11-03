from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import col, delete, select, update

from app.core.catalog import NOTIFICATION_TYPES
from app.core.config import get_settings
from app.core.deps import TenantDbDep, TenantUserDep, require_permission
from app.core.errors import not_found
from app.core.pagination import Page, PageDep, paginate
from app.core.security import utcnow
from app.modules.notifications.models import (
    Notification,
    PushSubscription,
    TenantNotificationSetting,
    UserNotificationPreference,
)
from app.modules.notifications.service import tenant_channels, user_channels
from app.modules.platform.audit import audit

router = APIRouter(prefix="/notifications", tags=["Notificaciones"])
settings = get_settings()


class NotificationOut(BaseModel):
    id: UUID
    type: str
    title: str
    body: str
    link: str | None
    read_at: datetime | None
    created_at: datetime


class UnreadCount(BaseModel):
    unread: int


class ChannelSetting(BaseModel):
    type: str
    name: str
    in_app: bool
    email: bool
    push: bool


class ChannelUpdate(BaseModel):
    type: str
    in_app: bool
    email: bool
    push: bool


class PushSubscriptionIn(BaseModel):
    endpoint: str
    p256dh: str
    auth: str


@router.get("", summary="Mis avisos", response_model=Page[NotificationOut])
def list_notifications(
    user: TenantUserDep, db: TenantDbDep, page: PageDep, unread_only: bool = False
) -> Page[NotificationOut]:
    query = select(Notification).where(Notification.user_id == user.id)
    if unread_only:
        query = query.where(col(Notification.read_at).is_(None))
    items, total = paginate(db, query.order_by(col(Notification.created_at).desc()), page)
    return Page(
        items=[NotificationOut.model_validate(n, from_attributes=True) for n in items],
        total=total,
        offset=page.offset,
        limit=page.limit,
    )


@router.get("/unread-count", summary="Número de avisos sin leer", response_model=UnreadCount)
def unread_count(user: TenantUserDep, db: TenantDbDep) -> UnreadCount:
    total = db.exec(
        select(func.count()).where(
            Notification.user_id == user.id, col(Notification.read_at).is_(None)
        )
    ).one()
    return UnreadCount(unread=int(total))


@router.post("/{notification_id}/read", summary="Marcar un aviso como leído", status_code=204)
def mark_read(notification_id: UUID, user: TenantUserDep, db: TenantDbDep) -> None:
    notification = db.get(Notification, notification_id)
    if notification is None or notification.user_id != user.id:
        raise not_found("Aviso no encontrado.")
    if notification.read_at is None:
        notification.read_at = utcnow()
        db.commit()


@router.post("/read-all", summary="Marcar todos como leídos", status_code=204)
def mark_all_read(user: TenantUserDep, db: TenantDbDep) -> None:
    db.exec(
        update(Notification)
        .where(col(Notification.user_id) == user.id, col(Notification.read_at).is_(None))
        .values(read_at=utcnow())
    )
    db.commit()


@router.get(
    "/preferences", summary="Mis canales por tipo de aviso", response_model=list[ChannelSetting]
)
def my_preferences(user: TenantUserDep, db: TenantDbDep) -> list[ChannelSetting]:
    assert user.tenant_id
    allowed = tenant_channels(db, user.tenant_id)
    mine = user_channels(db, user.tenant_id, user.id)
    # Devuelve lo que el usuario recibe; lo no permitido por la empresa va a False
    return [
        ChannelSetting(type=code, name=NOTIFICATION_TYPES[code].name, **mine[code].as_dict())
        for code in allowed
    ]


@router.put("/preferences", summary="Cambiar mis canales", response_model=list[ChannelSetting])
def update_my_preferences(
    data: list[ChannelUpdate], user: TenantUserDep, db: TenantDbDep
) -> list[ChannelSetting]:
    assert user.tenant_id
    existing = {
        p.type: p
        for p in db.exec(
            select(UserNotificationPreference).where(UserNotificationPreference.user_id == user.id)
        ).all()
    }
    for item in data:
        if item.type not in NOTIFICATION_TYPES:
            continue
        pref = existing.get(item.type) or UserNotificationPreference(
            tenant_id=user.tenant_id, user_id=user.id, type=item.type
        )
        pref.in_app, pref.email, pref.push = item.in_app, item.email, item.push
        db.add(pref)
    db.commit()
    return my_preferences(user, db)


@router.get(
    "/tenant-settings",
    summary="Canales permitidos en la empresa",
    response_model=list[ChannelSetting],
)
def get_tenant_settings(
    db: TenantDbDep, user=Depends(require_permission("notificaciones.configurar"))
) -> list[ChannelSetting]:
    return [
        ChannelSetting(type=code, name=NOTIFICATION_TYPES[code].name, **ch.as_dict())
        for code, ch in tenant_channels(db, user.tenant_id).items()
    ]


@router.put(
    "/tenant-settings",
    summary="Cambiar los canales permitidos en la empresa",
    response_model=list[ChannelSetting],
)
def update_tenant_settings(
    data: list[ChannelUpdate],
    db: TenantDbDep,
    user=Depends(require_permission("notificaciones.configurar")),
) -> list[ChannelSetting]:
    existing = {
        s.type: s
        for s in db.exec(
            select(TenantNotificationSetting).where(
                TenantNotificationSetting.tenant_id == user.tenant_id
            )
        ).all()
    }
    for item in data:
        if item.type not in NOTIFICATION_TYPES:
            continue
        row = existing.get(item.type) or TenantNotificationSetting(
            tenant_id=user.tenant_id, type=item.type
        )
        row.in_app, row.email, row.push = item.in_app, item.email, item.push
        db.add(row)
    audit(db, "notificaciones.configurar", user=user)
    db.commit()
    return get_tenant_settings(db, user)


@router.get("/push/public-key", summary="Clave pública VAPID para suscribirse a push")
def push_public_key(_: TenantUserDep) -> dict[str, str]:
    return {"public_key": settings.vapid_public_key}


@router.post("/push/subscriptions", summary="Registrar este navegador para push", status_code=204)
def subscribe_push(data: PushSubscriptionIn, user: TenantUserDep, db: TenantDbDep) -> None:
    sub = db.exec(
        select(PushSubscription).where(PushSubscription.endpoint == data.endpoint)
    ).first()
    if sub is None:
        sub = PushSubscription(tenant_id=user.tenant_id, user_id=user.id, **data.model_dump())  # type: ignore[arg-type]
    else:
        sub.user_id, sub.p256dh, sub.auth = user.id, data.p256dh, data.auth
    db.add(sub)
    db.commit()


@router.delete(
    "/push/subscriptions", summary="Dejar de recibir push en este navegador", status_code=204
)
def unsubscribe_push(endpoint: str, user: TenantUserDep, db: TenantDbDep) -> None:
    db.exec(
        delete(PushSubscription).where(
            col(PushSubscription.endpoint) == endpoint, col(PushSubscription.user_id) == user.id
        )
    )
    db.commit()
