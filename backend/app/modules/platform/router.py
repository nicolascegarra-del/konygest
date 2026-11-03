"""Panel de administración de Klyp: empresas, módulos, correo y modo soporte."""

from datetime import timedelta
from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import col, or_, select

from app.core.catalog import OPTIONAL_MODULES
from app.core.deps import PlatformDbDep, PlatformUserDep
from app.core.errors import not_found
from app.core.pagination import Page, PageDep
from app.core.security import create_access_token, utcnow
from app.modules.auth.schemas import TokenOut
from app.modules.auth.service import revoke_all
from app.modules.platform import email_config
from app.modules.platform.audit import audit
from app.modules.tenants.models import Tenant, TenantStatus
from app.modules.tenants.schemas import (
    AdminModuleUpdate,
    AdminTenantCreate,
    AdminTenantRow,
    AdminTenantUpdate,
    ModuleOut,
    TenantOut,
)
from app.modules.tenants.service import create_tenant, get_module_row, module_rows
from app.modules.users.models import User

router = APIRouter(prefix="/admin", tags=["Panel de Klyp"])


class StatsOut(BaseModel):
    tenants: dict[str, int]
    users: int
    active_users_30d: int


def _tenant_out(db, tenant: Tenant) -> TenantOut:
    return TenantOut(
        **tenant.model_dump(exclude={"modules"}),
        modules=[ModuleOut(**m) for m in module_rows(db, tenant.id)],
    )


def _get_tenant(db, tenant_id: UUID) -> Tenant:
    tenant = db.get(Tenant, tenant_id)
    if tenant is None:
        raise not_found("Empresa no encontrada.")
    return tenant


@router.get("/stats", summary="Métricas globales", response_model=StatsOut)
def stats(_: PlatformUserDep, db: PlatformDbDep) -> StatsOut:
    by_status = dict(db.exec(select(Tenant.status, func.count()).group_by(Tenant.status)).all())
    tenant_users = select(func.count()).select_from(User).where(col(User.tenant_id).is_not(None))
    since = utcnow() - timedelta(days=30)
    return StatsOut(
        tenants={s.value: int(by_status.get(s, 0)) for s in TenantStatus},
        users=int(db.exec(tenant_users).one()),
        active_users_30d=int(db.exec(tenant_users.where(col(User.last_login_at) >= since)).one()),
    )


@router.get("/tenants", summary="Empresas", response_model=Page[AdminTenantRow])
def list_tenants(
    _: PlatformUserDep,
    db: PlatformDbDep,
    page: PageDep,
    search: str | None = None,
    status: TenantStatus | None = None,
) -> Page[AdminTenantRow]:
    users = select(User.tenant_id, func.count().label("n")).group_by(User.tenant_id).subquery()
    query = select(Tenant, func.coalesce(users.c.n, 0)).outerjoin(
        users, users.c.tenant_id == Tenant.id
    )
    count_query = select(func.count()).select_from(Tenant)
    filters = []
    if search:
        pattern = f"%{search.strip()}%"
        filters.append(or_(col(Tenant.name).ilike(pattern), col(Tenant.tax_id).ilike(pattern)))
    if status:
        filters.append(Tenant.status == status)
    for f in filters:
        query = query.where(f)
        count_query = count_query.where(f)
    rows = db.exec(query.order_by(Tenant.name).offset(page.offset).limit(page.limit)).all()
    return Page(
        items=[AdminTenantRow(**tenant.model_dump(), users=int(n)) for tenant, n in rows],
        total=int(db.exec(count_query).one()),
        offset=page.offset,
        limit=page.limit,
    )


@router.post(
    "/tenants",
    summary="Dar de alta una empresa",
    description="Crea la empresa con los roles de plantilla e invita a su administrador.",
    response_model=TenantOut,
    status_code=201,
)
def add_tenant(data: AdminTenantCreate, user: PlatformUserDep, db: PlatformDbDep) -> TenantOut:
    tenant = create_tenant(
        db, data.name, data.tax_id, data.admin_email, data.admin_name, data.status
    )
    audit(
        db,
        "admin.empresa_alta",
        user=user,
        tenant_id=tenant.id,
        entity="tenant",
        entity_id=tenant.id,
    )
    db.commit()
    return _tenant_out(db, tenant)


@router.get("/tenants/{tenant_id}", summary="Ficha de una empresa", response_model=TenantOut)
def get_tenant(tenant_id: UUID, _: PlatformUserDep, db: PlatformDbDep) -> TenantOut:
    return _tenant_out(db, _get_tenant(db, tenant_id))


@router.patch(
    "/tenants/{tenant_id}",
    summary="Editar una empresa",
    description="Con `status: disabled` nadie de la empresa puede entrar; sus datos se conservan.",
    response_model=TenantOut,
)
def update_tenant(
    tenant_id: UUID, data: AdminTenantUpdate, user: PlatformUserDep, db: PlatformDbDep
) -> TenantOut:
    tenant = _get_tenant(db, tenant_id)
    changes = data.model_dump(exclude_unset=True, mode="json")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(tenant, key, value)
    db.add(tenant)
    audit(
        db,
        "admin.empresa_editar",
        user=user,
        tenant_id=tenant.id,
        entity="tenant",
        entity_id=tenant.id,
        data=changes,
    )
    db.commit()
    if data.status == TenantStatus.DISABLED:
        # Cierra las sesiones abiertas de la empresa
        for user_id in db.exec(select(User.id).where(User.tenant_id == tenant.id)).all():
            revoke_all(db, user_id)
    return _tenant_out(db, tenant)


@router.put(
    "/tenants/{tenant_id}/modules/{code}",
    summary="Módulo disponible (plan) y activo de una empresa",
    response_model=TenantOut,
)
def set_module(
    tenant_id: UUID, code: str, data: AdminModuleUpdate, user: PlatformUserDep, db: PlatformDbDep
) -> TenantOut:
    if code not in OPTIONAL_MODULES:
        raise not_found("Módulo no encontrado.")
    tenant = _get_tenant(db, tenant_id)
    row = get_module_row(db, tenant.id, code)
    row.available = data.available
    if data.enabled is not None:
        row.enabled = data.enabled
    if not data.available:
        row.enabled = False
    db.add(row)
    audit(
        db,
        "admin.empresa_modulo",
        user=user,
        tenant_id=tenant.id,
        data={"modulo": code, "disponible": row.available, "activo": row.enabled},
    )
    db.commit()
    return _tenant_out(db, tenant)


@router.post(
    "/tenants/{tenant_id}/support",
    summary="Entrar en modo soporte",
    description="Devuelve un access token para actuar dentro de la empresa. Queda auditado.",
    response_model=TokenOut,
)
def support_mode(tenant_id: UUID, user: PlatformUserDep, db: PlatformDbDep) -> TokenOut:
    tenant = _get_tenant(db, tenant_id)
    audit(
        db,
        "admin.modo_soporte",
        user=user,
        tenant_id=tenant.id,
        entity="tenant",
        entity_id=tenant.id,
    )
    db.commit()
    return TokenOut(access_token=create_access_token(user.id, tenant.id, support_mode=True))


@router.get(
    "/email-config",
    summary="SMTP global de la plataforma",
    description="404 si no está configurado (se usan las variables de entorno).",
    response_model=email_config.EmailConfigOut,
)
def get_email(_: PlatformUserDep, db: PlatformDbDep):
    row = email_config.get_config(db, None)
    if row is None:
        raise not_found("Sin configurar: se usan las variables de entorno.")
    return email_config.to_out(row)


@router.put(
    "/email-config", summary="Guardar el SMTP global", response_model=email_config.EmailConfigOut
)
def put_email(data: email_config.EmailConfigIn, user: PlatformUserDep, db: PlatformDbDep):
    row = email_config.save_config(db, None, data)
    audit(db, "admin.email_config", user=user)
    db.commit()
    return email_config.to_out(row)


@router.post("/email-config/test", summary="Enviar un email de prueba", status_code=204)
def test_email(data: email_config.EmailTestIn, _: PlatformUserDep, db: PlatformDbDep) -> None:
    row = email_config.get_config(db, None)
    if row is None:
        raise not_found("Guarda primero la configuración de correo.")
    email_config.send_test(row, data.to)
