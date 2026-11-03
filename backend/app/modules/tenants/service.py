from uuid import UUID

from sqlmodel import Session, select

from app.core.catalog import MODULES, OPTIONAL_MODULES, ROLE_TEMPLATES
from app.core.errors import conflict
from app.modules.auth.service import send_invitation
from app.modules.tenants.models import Tenant, TenantModule, TenantStatus
from app.modules.users.models import Role, RolePermission, User, UserRole

ADMIN_ROLE = "Administrador"


def seed_roles(session: Session, tenant_id: UUID) -> dict[str, Role]:
    """Crea los roles de plantilla (editables) de una empresa nueva."""
    roles = {}
    for template in ROLE_TEMPLATES:
        role = Role(
            tenant_id=tenant_id,
            name=template.name,
            description=template.description,
            dashboard_layout=[{"widget": w, "size": "md"} for w in template.widgets],
        )
        session.add(role)
        session.flush()
        for code, scope in template.permissions.items():
            session.add(
                RolePermission(
                    tenant_id=tenant_id, role_id=role.id, permission=code, scope=scope.value
                )
            )
        roles[template.name] = role
    return roles


def create_tenant(
    session: Session,
    name: str,
    tax_id: str | None,
    admin_email: str,
    admin_name: str,
    status: TenantStatus = TenantStatus.TRIAL,
) -> Tenant:
    """Alta de empresa con sus módulos, roles de plantilla y su primer administrador,
    al que se envía la invitación. Requiere una sesión de sistema."""
    email = admin_email.lower().strip()
    if session.exec(select(User).where(User.email == email)).first():
        raise conflict("Ya existe un usuario con ese email.", "admin_email")

    tenant = Tenant(name=name, tax_id=tax_id, status=status)
    session.add(tenant)
    session.flush()
    for code in OPTIONAL_MODULES:
        session.add(TenantModule(tenant_id=tenant.id, module_code=code))
    roles = seed_roles(session, tenant.id)
    admin = User(tenant_id=tenant.id, email=email, full_name=admin_name)
    session.add(admin)
    session.flush()
    session.add(UserRole(tenant_id=tenant.id, user_id=admin.id, role_id=roles[ADMIN_ROLE].id))
    send_invitation(session, admin, tenant.name)
    return tenant


def module_rows(session: Session, tenant_id: UUID) -> list[dict]:
    rows = {
        m.module_code: m
        for m in session.exec(select(TenantModule).where(TenantModule.tenant_id == tenant_id))
    }
    result = []
    for code in OPTIONAL_MODULES:
        row = rows.get(code)
        module = MODULES[code]
        result.append(
            {
                "code": code,
                "name": module.name,
                "description": module.description,
                "available": bool(row and row.available),
                "enabled": bool(row and row.available and row.enabled),
            }
        )
    return result


def get_module_row(session: Session, tenant_id: UUID, code: str) -> TenantModule:
    row = session.exec(
        select(TenantModule).where(
            TenantModule.tenant_id == tenant_id, TenantModule.module_code == code
        )
    ).first()
    if row is None:
        row = TenantModule(tenant_id=tenant_id, module_code=code)
    return row
