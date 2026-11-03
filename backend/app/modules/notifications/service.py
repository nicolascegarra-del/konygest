"""Avisos a usuarios por la app, email y push, según lo que permite la empresa
y lo que ha elegido cada usuario."""

import json
import logging
from dataclasses import dataclass
from uuid import UUID

from sqlmodel import Session, select

from app.core.catalog import NOTIFICATION_TYPES
from app.core.config import get_settings
from app.core.db import on_commit
from app.modules.notifications.models import (
    Notification,
    PushSubscription,
    TenantNotificationSetting,
    UserNotificationPreference,
)
from app.modules.platform.email import render, send_email
from app.modules.users.models import User

logger = logging.getLogger("konygest.notifications")
settings = get_settings()

CHANNELS = ("in_app", "email", "push")


@dataclass
class Channels:
    in_app: bool
    email: bool
    push: bool

    def as_dict(self) -> dict[str, bool]:
        return {c: getattr(self, c) for c in CHANNELS}


def tenant_channels(session: Session, tenant_id: UUID) -> dict[str, Channels]:
    """Canales permitidos de cada tipo en la empresa (o los del catálogo)."""
    rows = {
        r.type: r
        for r in session.exec(
            select(TenantNotificationSetting).where(
                TenantNotificationSetting.tenant_id == tenant_id
            )
        ).all()
    }
    result = {}
    for code, nt in NOTIFICATION_TYPES.items():
        row = rows.get(code)
        result[code] = (
            Channels(row.in_app, row.email, row.push)
            if row
            else Channels(nt.in_app, nt.email, nt.push)
        )
    return result


def user_channels(session: Session, tenant_id: UUID, user_id: UUID) -> dict[str, Channels]:
    """Canales efectivos de un usuario: su elección limitada por la empresa."""
    allowed = tenant_channels(session, tenant_id)
    prefs = {
        p.type: p
        for p in session.exec(
            select(UserNotificationPreference).where(UserNotificationPreference.user_id == user_id)
        ).all()
    }
    result = {}
    for code, base in allowed.items():
        pref = prefs.get(code)
        result[code] = Channels(
            in_app=base.in_app and (pref.in_app if pref else True),
            email=base.email and (pref.email if pref else True),
            push=base.push and (pref.push if pref else True),
        )
    return result


def notify(
    session: Session,
    tenant_id: UUID,
    user_ids: list[UUID],
    type_: str,
    title: str,
    body: str = "",
    link: str | None = None,
) -> None:
    """Crea los avisos y programa el email y el push para después del commit."""
    if type_ not in NOTIFICATION_TYPES:
        raise ValueError(f"Tipo de aviso desconocido: {type_}")
    for user_id in user_ids:
        user = session.get(User, user_id)
        if user is None or not user.is_active:
            continue
        channels = user_channels(session, tenant_id, user_id)[type_]
        if channels.in_app:
            session.add(
                Notification(
                    tenant_id=tenant_id,
                    user_id=user_id,
                    type=type_,
                    title=title,
                    body=body,
                    link=link,
                )
            )
        if channels.email:
            url = f"{settings.app_url}{link}" if link else None
            html = render(
                title, [body] if body else [], ("Abrir en Konygest", url) if url else None
            )
            email = user.email
            on_commit(session, lambda e=email, h=html: send_email(tenant_id, e, title, h))
        if channels.push:
            subs = session.exec(
                select(PushSubscription).where(PushSubscription.user_id == user_id)
            ).all()
            payload = json.dumps({"title": title, "body": body, "link": link})
            for sub in subs:
                info = {"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}}
                on_commit(session, lambda i=info, p=payload: send_push(i, p))


def send_push(subscription_info: dict, payload: str) -> None:
    if not settings.vapid_private_key:
        return
    from pywebpush import WebPushException, webpush

    try:
        webpush(
            subscription_info=subscription_info,
            data=payload,
            vapid_private_key=settings.vapid_private_key,
            vapid_claims={"sub": settings.vapid_subject},
        )
    except WebPushException:
        logger.warning("No se pudo enviar un push", exc_info=True)
