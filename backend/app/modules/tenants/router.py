from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import col, select

from app.core.catalog import OPTIONAL_MODULES
from app.core.deps import CurrentUser, TenantDbDep, TenantUserDep, require_permission
from app.core.errors import AppError, not_found
from app.core.pagination import Page, PageDep, paginate
from app.modules.platform import email_config
from app.modules.platform.audit import audit
from app.modules.platform.models import AuditLog
from app.modules.tenants.models import Tenant
from app.modules.tenants.schemas import (
    ModuleOut,
    ModuleToggle,
    TenantOut,
    TenantSummary,
    TenantUpdate,
)
from app.modules.tenants.service import get_module_row, module_rows
from app.modules.users.models import Role, User

router = APIRouter(tags=["Empresa"])

ConfigUser = Depends(require_permission("empresa.configurar"))


def _tenant_out(db, tenant: Tenant) -> TenantOut:
    return TenantOut(
        **tenant.model_dump(exclude={"modules"}),
        modules=[ModuleOut(**m) for m in module_rows(db, tenant.id)],
    )


@router.get("/tenant", summary="Datos de mi empresa", response_model=TenantOut)
def get_tenant(user: TenantUserDep, db: TenantDbDep) -> TenantOut:
    tenant = db.get(Tenant, user.tenant_id)
    if tenant is None:
        raise not_found()
    return _tenant_out(db, tenant)


@router.patch("/tenant", summary="Editar mi empresa", response_model=TenantOut)
def update_tenant(data: TenantUpdate, db: TenantDbDep, user: CurrentUser = ConfigUser) -> TenantOut:
    tenant = db.get(Tenant, user.tenant_id)
    if tenant is None:
        raise not_found()
    changes = data.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(tenant, key, value)
    db.add(tenant)
    audit(db, "empresa.editar", user=user, entity="tenant", entity_id=tenant.id, data=changes)
    db.commit()
    return _tenant_out(db, tenant)


@router.put(
    "/tenant/modules/{code}",
    summary="Activar o desactivar un módulo opcional",
    description="Solo módulos que Klyp ha dejado disponibles en el plan de la empresa.",
    response_model=TenantOut,
)
def toggle_module(
    code: str, data: ModuleToggle, db: TenantDbDep, user: CurrentUser = ConfigUser
) -> TenantOut:
    if code not in OPTIONAL_MODULES:
        raise not_found("Módulo no encontrado.")
    row = get_module_row(db, user.tenant_id, code)  # type: ignore[arg-type]
    if not row.available:
        raise AppError(403, "MODULE_NOT_AVAILABLE", "Este módulo no está incluido en tu plan.")
    row.enabled = data.enabled
    db.add(row)
    audit(db, "empresa.modulo", user=user, data={"modulo": code, "activo": data.enabled})
    db.commit()
    return get_tenant(user, db)


@router.get("/tenant/summary", summary="Resumen de la empresa", response_model=TenantSummary)
def tenant_summary(
    db: TenantDbDep, user=Depends(require_permission("usuarios.ver"))
) -> TenantSummary:
    users = db.exec(select(func.count()).select_from(User)).one()
    active = db.exec(select(func.count()).select_from(User).where(User.is_active)).one()
    roles = db.exec(select(func.count()).select_from(Role)).one()
    return TenantSummary(
        users=users,
        active_users=active,
        roles=roles,
        modules_enabled=sorted(m for m in user.modules if m in OPTIONAL_MODULES),
    )


@router.get(
    "/tenant/email-config",
    summary="SMTP propio de la empresa",
    description="404 si la empresa usa el correo de la plataforma.",
    response_model=email_config.EmailConfigOut,
)
def get_email_config(db: TenantDbDep, user: CurrentUser = ConfigUser):
    row = email_config.get_config(db, user.tenant_id)
    if row is None:
        raise not_found("La empresa usa el correo de la plataforma.")
    return email_config.to_out(row)


@router.put(
    "/tenant/email-config",
    summary="Guardar SMTP propio",
    response_model=email_config.EmailConfigOut,
)
def put_email_config(
    data: email_config.EmailConfigIn, db: TenantDbDep, user: CurrentUser = ConfigUser
):
    row = email_config.save_config(db, user.tenant_id, data)
    audit(db, "empresa.email_config", user=user)
    db.commit()
    return email_config.to_out(row)


@router.delete("/tenant/email-config", summary="Volver al correo de la plataforma", status_code=204)
def delete_email_config(db: TenantDbDep, user: CurrentUser = ConfigUser) -> None:
    row = email_config.get_config(db, user.tenant_id)
    if row:
        db.delete(row)
        audit(db, "empresa.email_config_borrar", user=user)
        db.commit()


@router.post(
    "/tenant/email-config/test",
    summary="Enviar un email de prueba con el SMTP propio",
    status_code=204,
)
def test_email_config(
    data: email_config.EmailTestIn, db: TenantDbDep, user: CurrentUser = ConfigUser
) -> None:
    row = email_config.get_config(db, user.tenant_id)
    if row is None:
        raise not_found("Guarda primero la configuración de correo.")
    email_config.send_test(row, data.to)


class AuditOut(BaseModel):
    id: UUID
    action: str
    user_email: str | None
    entity: str
    entity_id: str | None
    data: dict[str, Any]
    created_at: datetime


@router.get("/audit", summary="Registro de actividad", response_model=Page[AuditOut])
def list_audit(
    db: TenantDbDep, page: PageDep, _=Depends(require_permission("auditoria.ver"))
) -> Page[AuditOut]:
    query = select(AuditLog).order_by(col(AuditLog.created_at).desc())
    rows, total = paginate(db, query, page)
    user_ids = {r.user_id for r in rows if r.user_id}
    emails = (
        dict(db.exec(select(User.id, User.email).where(col(User.id).in_(user_ids))).all())
        if user_ids
        else {}
    )
    return Page(
        items=[
            AuditOut(
                id=r.id,
                action=r.action,
                user_email=emails.get(r.user_id) if r.user_id else None,
                entity=r.entity,
                entity_id=r.entity_id,
                data=r.data,
                created_at=r.created_at,
            )
            for r in rows
        ],
        total=total,
        offset=page.offset,
        limit=page.limit,
    )
