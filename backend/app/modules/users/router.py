from uuid import UUID

from fastapi import APIRouter, Depends
from sqlmodel import col, or_, select

from app.core.catalog import PERMISSIONS, WIDGETS
from app.core.db import new_session
from app.core.deps import (
    CurrentUser,
    CurrentUserDep,
    TenantDbDep,
    TenantUserDep,
    require_permission,
)
from app.core.errors import bad_request, conflict, not_found
from app.core.pagination import Page, PageDep, paginate
from app.core.security import hash_password, verify_password
from app.modules.auth.schemas import ChangePasswordIn, MeOut, ProfileIn
from app.modules.auth.service import revoke_all, send_invitation, validate_password
from app.modules.notifications.service import notify
from app.modules.platform.audit import audit
from app.modules.users import service
from app.modules.users.models import Role, RolePermission, User, UserDashboard, UserRole
from app.modules.users.schemas import (
    DashboardIn,
    DashboardOut,
    PermissionOut,
    RoleIn,
    RoleOut,
    RoleUpdate,
    UserCreate,
    UserOut,
    UserUpdate,
    WidgetCatalogItem,
    WidgetItem,
)

router = APIRouter(tags=["Usuarios y roles"])

ManageUsers = Depends(require_permission("usuarios.gestionar"))
ManageRoles = Depends(require_permission("roles.gestionar"))


# ─── Yo ────────────────────────────────────────────


@router.get("/me", summary="Mi usuario, empresa, permisos y módulos", response_model=MeOut)
def me(user: CurrentUserDep) -> MeOut:
    return MeOut.from_current(user)


@router.patch("/me", summary="Editar mi perfil", response_model=MeOut)
def update_me(data: ProfileIn, user: CurrentUserDep) -> MeOut:
    with new_session(bypass_rls=True) as db:
        row = db.get(User, user.id)
        assert row
        row.full_name = data.full_name
        db.add(row)
        db.commit()
    user.full_name = data.full_name
    return MeOut.from_current(user)


@router.post("/me/password", summary="Cambiar mi contraseña", status_code=204)
def change_password(data: ChangePasswordIn, user: CurrentUserDep) -> None:
    validate_password(data.new_password)
    with new_session(bypass_rls=True) as db:
        row = db.get(User, user.id)
        assert row
        if not verify_password(data.current_password, row.password_hash):
            raise bad_request(
                "INVALID_CREDENTIALS", "La contraseña actual no es correcta.", "current_password"
            )
        row.password_hash = hash_password(data.new_password)
        db.add(row)
        audit(db, "auth.cambio_password", tenant_id=row.tenant_id, user_id=row.id)
        db.commit()
        revoke_all(db, row.id)


def _dashboard_out(db, user: CurrentUser) -> DashboardOut:
    layout, customized = service.get_dashboard(db, user)
    return DashboardOut(
        layout=[WidgetItem(**w) for w in layout],
        customized=customized,
        catalog=[
            WidgetCatalogItem(code=c, name=WIDGETS[c].name, description=WIDGETS[c].description)
            for c in service.visible_widgets(user)
        ],
    )


@router.get("/me/dashboard", summary="Mi pantalla inicial", response_model=DashboardOut)
def my_dashboard(user: TenantUserDep, db: TenantDbDep) -> DashboardOut:
    return _dashboard_out(db, user)


@router.put("/me/dashboard", summary="Guardar mi pantalla inicial", response_model=DashboardOut)
def save_my_dashboard(data: DashboardIn, user: TenantUserDep, db: TenantDbDep) -> DashboardOut:
    allowed = set(service.visible_widgets(user))
    layout = [w for w in service.validate_layout(data.layout) if w["widget"] in allowed]
    own = db.exec(select(UserDashboard).where(UserDashboard.user_id == user.id)).first()
    if own is None:
        own = UserDashboard(tenant_id=user.tenant_id, user_id=user.id)  # type: ignore[arg-type]
    own.layout = layout
    db.add(own)
    db.commit()
    return _dashboard_out(db, user)


@router.delete(
    "/me/dashboard", summary="Volver a la pantalla inicial de mi rol", response_model=DashboardOut
)
def reset_my_dashboard(user: TenantUserDep, db: TenantDbDep) -> DashboardOut:
    own = db.exec(select(UserDashboard).where(UserDashboard.user_id == user.id)).first()
    if own:
        db.delete(own)
        db.commit()
    return _dashboard_out(db, user)


# ─── Usuarios ──────────────────────────────────────


@router.get("/users", summary="Usuarios de la empresa", response_model=Page[UserOut])
def list_users(
    db: TenantDbDep,
    page: PageDep,
    search: str | None = None,
    _=Depends(require_permission("usuarios.ver")),
) -> Page[UserOut]:
    query = select(User).order_by(User.full_name)
    if search:
        pattern = f"%{search.strip()}%"
        query = query.where(or_(col(User.full_name).ilike(pattern), col(User.email).ilike(pattern)))
    users, total = paginate(db, query, page)
    return Page(
        items=service.users_out(db, users), total=total, offset=page.offset, limit=page.limit
    )


@router.post(
    "/users",
    summary="Invitar a un usuario",
    description="Crea el usuario sin contraseña y le envía un enlace de invitación.",
    response_model=UserOut,
    status_code=201,
)
def create_user(data: UserCreate, db: TenantDbDep, user: CurrentUser = ManageUsers) -> UserOut:
    email = data.email.lower().strip()
    # El email es único en toda la plataforma, así que se comprueba sin aislamiento
    with new_session(bypass_rls=True) as system:
        if system.exec(select(User.id).where(User.email == email)).first():
            raise conflict("Ya existe un usuario con ese email.", "email")
    service.check_roles(db, data.role_ids)
    new_user = User(tenant_id=user.tenant_id, email=email, full_name=data.full_name)
    db.add(new_user)
    db.flush()
    service.set_user_roles(db, user.tenant_id, new_user.id, data.role_ids)  # type: ignore[arg-type]
    audit(db, "usuario.invitar", user=user, entity="user", entity_id=new_user.id)
    admins = _user_admin_ids(db, exclude=[user.id, new_user.id])
    if admins:
        notify(
            db,
            user.tenant_id,  # type: ignore[arg-type]
            admins,
            "usuario_alta",
            "Nuevo usuario",
            f"{user.full_name} ha invitado a {new_user.full_name}.",
            "/ajustes/usuarios",
        )
    send_invitation(db, new_user, user.tenant_name)
    return service.users_out(db, [new_user])[0]


def _user_admin_ids(db, exclude: list[UUID]) -> list[UUID]:
    return list(
        db.exec(
            select(UserRole.user_id)
            .join(RolePermission, RolePermission.role_id == UserRole.role_id)
            .where(
                RolePermission.permission == "usuarios.gestionar",
                col(UserRole.user_id).not_in(exclude),
            )
            .distinct()
        ).all()
    )


@router.patch("/users/{user_id}", summary="Editar un usuario", response_model=UserOut)
def update_user(
    user_id: UUID, data: UserUpdate, db: TenantDbDep, user: CurrentUser = ManageUsers
) -> UserOut:
    target = db.get(User, user_id)
    if target is None:
        raise not_found("Usuario no encontrado.")
    if target.id == user.id and data.is_active is False:
        raise bad_request("CANNOT_DISABLE_SELF", "No puedes desactivarte a ti mismo.")
    changes = data.model_dump(exclude_unset=True, mode="json")
    if data.full_name is not None:
        target.full_name = data.full_name
    if data.is_active is not None:
        target.is_active = data.is_active
    if data.role_ids is not None:
        service.set_user_roles(db, user.tenant_id, target.id, data.role_ids)  # type: ignore[arg-type]
    db.add(target)
    audit(db, "usuario.editar", user=user, entity="user", entity_id=target.id, data=changes)
    db.commit()
    if data.is_active is False:
        with new_session(bypass_rls=True) as system:
            revoke_all(system, target.id)
    return service.users_out(db, [target])[0]


@router.post("/users/{user_id}/resend-invite", summary="Reenviar la invitación", status_code=204)
def resend_invite(user_id: UUID, db: TenantDbDep, user: CurrentUser = ManageUsers) -> None:
    target = db.get(User, user_id)
    if target is None:
        raise not_found("Usuario no encontrado.")
    if target.password_hash is not None:
        raise bad_request("ALREADY_ACTIVE", "Este usuario ya ha creado su contraseña.")
    send_invitation(db, target, user.tenant_name)


# ─── Roles ─────────────────────────────────────────


@router.get("/permissions", summary="Catálogo de permisos", response_model=list[PermissionOut])
def list_permissions(user: TenantUserDep) -> list[PermissionOut]:
    return [
        PermissionOut(
            code=p.code,
            area=p.area,
            name=p.name,
            module=p.module,
            scoped=p.scoped,
            available=p.module in user.modules,
        )
        for p in PERMISSIONS.values()
    ]


@router.get("/roles", summary="Roles de la empresa", response_model=list[RoleOut])
def list_roles(db: TenantDbDep, _=Depends(require_permission("usuarios.ver"))) -> list[RoleOut]:
    roles = db.exec(select(Role).order_by(Role.name)).all()
    return service.roles_out(db, list(roles))


@router.post("/roles", summary="Crear un rol", response_model=RoleOut, status_code=201)
def create_role(data: RoleIn, db: TenantDbDep, user: CurrentUser = ManageRoles) -> RoleOut:
    service.ensure_unique_role_name(db, data.name)
    permissions = service.validate_permissions(data.permissions, user.modules)
    role = Role(
        tenant_id=user.tenant_id,  # type: ignore[arg-type]
        name=data.name.strip(),
        description=data.description,
        dashboard_layout=service.validate_layout(data.dashboard_layout),
    )
    db.add(role)
    db.flush()
    service.replace_role_permissions(db, role, permissions)
    audit(db, "rol.crear", user=user, entity="role", entity_id=role.id, data={"nombre": role.name})
    db.commit()
    return service.roles_out(db, [role])[0]


@router.patch("/roles/{role_id}", summary="Editar un rol", response_model=RoleOut)
def update_role(
    role_id: UUID, data: RoleUpdate, db: TenantDbDep, user: CurrentUser = ManageRoles
) -> RoleOut:
    role = service.get_role(db, role_id)
    if data.name is not None:
        service.ensure_unique_role_name(db, data.name, exclude=role.id)
        role.name = data.name.strip()
    if data.description is not None:
        role.description = data.description
    if data.dashboard_layout is not None:
        role.dashboard_layout = service.validate_layout(data.dashboard_layout)
    if data.permissions is not None:
        permissions = service.validate_permissions(data.permissions, user.modules)
        _ensure_someone_keeps_role_admin(db, role.id, permissions)
        service.replace_role_permissions(db, role, permissions)
    db.add(role)
    audit(db, "rol.editar", user=user, entity="role", entity_id=role.id, data={"nombre": role.name})
    db.commit()
    return service.roles_out(db, [role])[0]


def _ensure_someone_keeps_role_admin(db, role_id: UUID, new_permissions: dict) -> None:
    """Evita que la empresa se quede sin nadie capaz de gestionar roles."""
    had_it = db.exec(
        select(RolePermission.id).where(
            RolePermission.role_id == role_id, RolePermission.permission == "roles.gestionar"
        )
    ).first()
    if "roles.gestionar" in new_permissions or had_it is None:
        return
    others = db.exec(
        select(UserRole.user_id)
        .join(RolePermission, RolePermission.role_id == UserRole.role_id)
        .join(User, User.id == UserRole.user_id)
        .where(
            RolePermission.permission == "roles.gestionar",
            RolePermission.role_id != role_id,
            User.is_active,
        )
    ).first()
    if others is None:
        raise bad_request(
            "LAST_ADMIN_ROLE",
            "Ningún otro rol con usuarios activos puede gestionar roles; "
            "no puedes quitar ese permiso.",
            "permissions",
        )


@router.delete("/roles/{role_id}", summary="Borrar un rol", status_code=204)
def delete_role(role_id: UUID, db: TenantDbDep, user: CurrentUser = ManageRoles) -> None:
    role = service.get_role(db, role_id)
    if db.exec(select(UserRole.id).where(UserRole.role_id == role.id)).first():
        raise conflict("El rol tiene usuarios asignados. Cámbialos de rol antes de borrarlo.")
    audit(db, "rol.borrar", user=user, entity="role", entity_id=role.id, data={"nombre": role.name})
    db.delete(role)
    db.commit()
