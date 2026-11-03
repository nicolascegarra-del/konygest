from uuid import UUID

from sqlalchemy import func
from sqlmodel import Session, col, delete, select

from app.core.catalog import PERMISSIONS, WIDGETS, Scope
from app.core.deps import CurrentUser
from app.core.errors import bad_request, conflict, not_found
from app.modules.users.models import Role, RolePermission, User, UserDashboard, UserRole
from app.modules.users.schemas import RoleOut, RoleRef, UserOut, WidgetItem


def users_out(session: Session, users: list[User]) -> list[UserOut]:
    ids = [u.id for u in users]
    roles: dict[UUID, list[RoleRef]] = {i: [] for i in ids}
    if ids:
        rows = session.exec(
            select(UserRole.user_id, Role.id, Role.name)
            .join(Role, Role.id == UserRole.role_id)
            .where(col(UserRole.user_id).in_(ids))
            .order_by(Role.name)
        ).all()
        for user_id, role_id, name in rows:
            roles[user_id].append(RoleRef(id=role_id, name=name))
    return [
        UserOut(
            id=u.id,
            email=u.email,
            full_name=u.full_name,
            is_active=u.is_active,
            roles=roles[u.id],
            last_login_at=u.last_login_at,
            pending_invite=u.password_hash is None,
        )
        for u in users
    ]


def check_roles(session: Session, role_ids: list[UUID]) -> None:
    """Los roles deben existir en la empresa (RLS ya oculta los de otras)."""
    found = session.exec(select(Role.id).where(col(Role.id).in_(role_ids))).all()
    if len(set(found)) != len(set(role_ids)):
        raise bad_request("INVALID_ROLE", "Alguno de los roles no existe.", "role_ids")


def set_user_roles(session: Session, tenant_id: UUID, user_id: UUID, role_ids: list[UUID]) -> None:
    check_roles(session, role_ids)
    session.exec(delete(UserRole).where(col(UserRole.user_id) == user_id))
    for role_id in set(role_ids):
        session.add(UserRole(tenant_id=tenant_id, user_id=user_id, role_id=role_id))


def validate_permissions(permissions: dict[str, str], modules: set[str]) -> dict[str, Scope]:
    """Solo permisos del catálogo, de módulos activos y con alcance válido."""
    result: dict[str, Scope] = {}
    for code, scope in permissions.items():
        perm = PERMISSIONS.get(code)
        if perm is None:
            raise bad_request("INVALID_PERMISSION", f"Permiso desconocido: {code}", "permissions")
        if perm.module not in modules:
            raise bad_request(
                "MODULE_DISABLED",
                f"El permiso «{perm.name}» es de un módulo que no está activo.",
                "permissions",
            )
        result[code] = Scope.ALL if not perm.scoped else Scope(scope)
    return result


def validate_layout(layout: list[WidgetItem]) -> list[dict]:
    seen = set()
    result = []
    for item in layout:
        if item.widget not in WIDGETS:
            raise bad_request("INVALID_WIDGET", f"Widget desconocido: {item.widget}", "layout")
        if item.widget in seen:
            continue
        seen.add(item.widget)
        result.append(item.model_dump())
    return result


def replace_role_permissions(session: Session, role: Role, permissions: dict[str, Scope]) -> None:
    session.exec(delete(RolePermission).where(col(RolePermission.role_id) == role.id))
    for code, scope in permissions.items():
        session.add(
            RolePermission(
                tenant_id=role.tenant_id, role_id=role.id, permission=code, scope=scope.value
            )
        )


def roles_out(session: Session, roles: list[Role]) -> list[RoleOut]:
    ids = [r.id for r in roles]
    perms: dict[UUID, dict[str, str]] = {i: {} for i in ids}
    counts: dict[UUID, int] = {}
    if ids:
        for role_id, code, scope in session.exec(
            select(RolePermission.role_id, RolePermission.permission, RolePermission.scope).where(
                col(RolePermission.role_id).in_(ids)
            )
        ).all():
            perms[role_id][code] = scope
        counts = dict(
            session.exec(
                select(UserRole.role_id, func.count())
                .where(col(UserRole.role_id).in_(ids))
                .group_by(UserRole.role_id)
            ).all()
        )
    return [
        RoleOut(
            id=r.id,
            name=r.name,
            description=r.description,
            user_count=counts.get(r.id, 0),
            permissions=perms[r.id],  # type: ignore[arg-type]
            dashboard_layout=[WidgetItem(**w) for w in r.dashboard_layout or []],
        )
        for r in roles
    ]


def get_role(session: Session, role_id: UUID) -> Role:
    role = session.get(Role, role_id)
    if role is None:
        raise not_found("Rol no encontrado.")
    return role


def ensure_unique_role_name(session: Session, name: str, exclude: UUID | None = None) -> None:
    query = select(Role.id).where(func.lower(Role.name) == name.lower().strip())
    if exclude:
        query = query.where(Role.id != exclude)
    if session.exec(query).first():
        raise conflict("Ya hay un rol con ese nombre.", "name")


def visible_widgets(user: CurrentUser) -> list[str]:
    return [
        code
        for code, w in WIDGETS.items()
        if w.module in user.modules and (w.permission is None or user.can(w.permission))
    ]


def role_default_layout(session: Session, user_id: UUID) -> list[dict]:
    """Une las pantallas de los roles del usuario, en orden y sin repetir."""
    layouts = session.exec(
        select(Role.dashboard_layout)
        .join(UserRole, UserRole.role_id == Role.id)
        .where(UserRole.user_id == user_id)
        .order_by(Role.name)
    ).all()
    seen: set[str] = set()
    result = []
    for layout in layouts:
        for item in layout or []:
            if item.get("widget") not in seen:
                seen.add(item["widget"])
                result.append(item)
    return result


def get_dashboard(session: Session, user: CurrentUser) -> tuple[list[dict], bool]:
    own = session.exec(select(UserDashboard).where(UserDashboard.user_id == user.id)).first()
    layout = own.layout if own else role_default_layout(session, user.id)
    if not layout:
        layout = [{"widget": "bienvenida", "size": "md"}]
    allowed = set(visible_widgets(user))
    return [w for w in layout if w.get("widget") in allowed], own is not None
