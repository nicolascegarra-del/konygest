"""Dependencias de FastAPI: usuario autenticado, permisos, módulos y sesión de BD."""

from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Annotated
from uuid import UUID

import jwt
from fastapi import Depends, Request
from sqlmodel import Session, select

from app.core.catalog import MODULES, OPTIONAL_MODULES, PERMISSIONS, Scope
from app.core.db import new_session
from app.core.errors import AppError, forbidden
from app.core.security import decode_access_token
from app.modules.tenants.models import Tenant, TenantModule, TenantStatus
from app.modules.users.models import PlatformRole, RolePermission, User, UserRole


@dataclass
class CurrentUser:
    id: UUID
    email: str
    full_name: str
    tenant_id: UUID | None
    tenant_name: str | None
    platform_role: PlatformRole | None
    # permiso -> alcance ("all" gana a "own" si varios roles lo conceden)
    permissions: dict[str, Scope] = field(default_factory=dict)
    modules: set[str] = field(default_factory=set)
    support_mode: bool = False
    read_only: bool = False
    totp_enabled: bool = False
    # Su empresa (o el panel de Klyp) exige 2FA y aún no lo ha activado
    must_setup_2fa: bool = False

    @property
    def is_platform(self) -> bool:
        return self.platform_role is not None and not self.support_mode

    def can(self, permission: str) -> bool:
        return permission in self.permissions

    def scope(self, permission: str) -> Scope | None:
        return self.permissions.get(permission)


def _unauthorized(message: str = "Sesión no válida o caducada.") -> AppError:
    return AppError(401, "UNAUTHORIZED", message)


def enabled_modules(session: Session, tenant_id: UUID) -> set[str]:
    rows = session.exec(
        select(TenantModule.module_code).where(
            TenantModule.tenant_id == tenant_id,
            TenantModule.available,
            TenantModule.enabled,
        )
    ).all()
    core = {code for code, m in MODULES.items() if not m.optional}
    return core | {code for code in rows if code in OPTIONAL_MODULES}


def resolve_permissions(session: Session, user_id: UUID, modules: set[str]) -> dict[str, Scope]:
    rows = session.exec(
        select(RolePermission.permission, RolePermission.scope)
        .join(UserRole, UserRole.role_id == RolePermission.role_id)
        .where(UserRole.user_id == user_id)
    ).all()
    result: dict[str, Scope] = {}
    for code, scope in rows:
        perm = PERMISSIONS.get(code)
        if perm is None or perm.module not in modules:
            continue
        if result.get(code) != Scope.ALL:
            result[code] = Scope(scope)
    return result


def load_current_user(user_id: UUID, tenant_id: UUID | None, support: bool) -> CurrentUser:
    """Carga usuario, empresa, módulos y permisos con una sesión de sistema.

    Es seguro saltarse el aislamiento aquí porque solo se lee lo que indica un
    JWT firmado por nosotros.
    """
    with new_session(bypass_rls=True) as session:
        user = session.get(User, user_id)
        if user is None or not user.is_active:
            raise _unauthorized()

        if support:
            # Personal de Klyp dentro de una empresa: todos los permisos activos
            if user.platform_role is None or tenant_id is None:
                raise _unauthorized()
        elif user.tenant_id != tenant_id:
            raise _unauthorized()

        current = CurrentUser(
            id=user.id,
            email=user.email,
            full_name=user.full_name,
            tenant_id=tenant_id,
            tenant_name=None,
            platform_role=user.platform_role,
            support_mode=support,
            totp_enabled=user.totp_enabled,
        )
        if tenant_id is None:
            # El personal de Klyp siempre necesita 2FA
            current.must_setup_2fa = not user.totp_enabled
            return current

        tenant = session.get(Tenant, tenant_id)
        if tenant is None:
            raise _unauthorized()
        if tenant.status == TenantStatus.DISABLED and not support:
            raise AppError(403, "TENANT_DISABLED", "Tu empresa está desactivada.")
        current.tenant_name = tenant.name
        current.must_setup_2fa = tenant.require_2fa and not user.totp_enabled and not support
        current.read_only = tenant.status == TenantStatus.PAST_DUE and not support
        current.modules = enabled_modules(session, tenant_id)
        if support:
            current.permissions = {
                code: Scope.ALL for code, p in PERMISSIONS.items() if p.module in current.modules
            }
        else:
            current.permissions = resolve_permissions(session, user.id, current.modules)
        return current


def get_current_user(request: Request) -> CurrentUser:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise _unauthorized("Debes iniciar sesión.")
    try:
        payload = decode_access_token(header.removeprefix("Bearer ").strip())
        user_id = UUID(payload["sub"])
        tenant_id = UUID(payload["tid"]) if payload.get("tid") else None
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        raise _unauthorized() from exc
    current = load_current_user(user_id, tenant_id, payload.get("act") == "support")
    request.state.user_id = current.id
    return current


CurrentUserDep = Annotated[CurrentUser, Depends(get_current_user)]


def _two_factor_required() -> AppError:
    return AppError(
        403, "TWO_FACTOR_SETUP_REQUIRED", "Activa la verificación en dos pasos para continuar."
    )


def get_tenant_user(user: CurrentUserDep, request: Request) -> CurrentUser:
    if user.tenant_id is None:
        raise forbidden("Esta sección es de una empresa.")
    if user.must_setup_2fa:
        raise _two_factor_required()
    # Empresa en impago: se puede consultar pero no modificar
    if user.read_only and request.method not in ("GET", "HEAD", "OPTIONS"):
        raise AppError(
            402, "SUBSCRIPTION_PAST_DUE", "La suscripción está pendiente de pago: solo lectura."
        )
    return user


TenantUserDep = Annotated[CurrentUser, Depends(get_tenant_user)]


def get_tenant_db(user: TenantUserDep) -> Iterator[Session]:
    with new_session(tenant_id=user.tenant_id) as session:
        yield session


TenantDbDep = Annotated[Session, Depends(get_tenant_db)]


def require_permission(permission: str) -> Callable[[CurrentUser], CurrentUser]:
    def checker(user: TenantUserDep) -> CurrentUser:
        if not user.can(permission):
            raise forbidden()
        return user

    return checker


def require_module(module: str) -> Callable[[CurrentUser], CurrentUser]:
    def checker(user: TenantUserDep) -> CurrentUser:
        if module not in user.modules:
            raise AppError(403, "MODULE_DISABLED", "Este módulo no está activo en tu empresa.")
        return user

    return checker


def get_platform_user(user: CurrentUserDep) -> CurrentUser:
    if not user.is_platform:
        raise forbidden("Solo para el equipo de Klyp.")
    if user.must_setup_2fa:
        raise _two_factor_required()
    return user


PlatformUserDep = Annotated[CurrentUser, Depends(get_platform_user)]


def get_platform_db(_: PlatformUserDep) -> Iterator[Session]:
    with new_session(bypass_rls=True) as session:
        yield session


PlatformDbDep = Annotated[Session, Depends(get_platform_db)]
