from typing import Any
from uuid import UUID

from sqlmodel import Session

from app.core.deps import CurrentUser
from app.modules.platform.models import AuditLog


def audit(
    session: Session,
    action: str,
    *,
    user: CurrentUser | None = None,
    tenant_id: UUID | None = None,
    user_id: UUID | None = None,
    entity: str = "",
    entity_id: UUID | str | None = None,
    data: dict[str, Any] | None = None,
) -> None:
    """Añade una entrada al registro de actividad (se guarda con el commit de la sesión)."""
    payload = dict(data or {})
    if user is not None and user.support_mode:
        payload["modo_soporte"] = True
    session.add(
        AuditLog(
            tenant_id=tenant_id or (user.tenant_id if user else None),
            user_id=user_id or (user.id if user else None),
            action=action,
            entity=entity,
            entity_id=str(entity_id) if entity_id else None,
            data=payload,
        )
    )
