from datetime import timedelta
from functools import lru_cache
from uuid import UUID

from sqlmodel import Session, col, select, update

from app.core.config import get_settings
from app.core.db import new_session
from app.core.errors import AppError, bad_request
from app.core.security import (
    create_access_token,
    decrypt_secret,
    hash_password,
    hash_token,
    new_opaque_token,
    utcnow,
    verify_password,
    verify_totp,
)
from app.modules.auth.models import ActionPurpose, ActionToken, AuthSession
from app.modules.platform.audit import audit
from app.modules.platform.email import render, send_email
from app.modules.tenants.models import Tenant, TenantStatus
from app.modules.users.models import User

settings = get_settings()

INVITE_DAYS = 7
RESET_HOURS = 2
MIN_PASSWORD_LENGTH = 10


@lru_cache
def _dummy_hash() -> str:
    return hash_password("contraseña-inexistente")


def _invalid_credentials() -> AppError:
    return AppError(401, "INVALID_CREDENTIALS", "Email o contraseña incorrectos.")


def authenticate(session: Session, email: str, password: str, totp_code: str | None) -> User:
    """Comprueba credenciales, bloqueo, empresa y 2FA. Cuenta los intentos fallidos."""
    user = session.exec(select(User).where(User.email == email.lower().strip())).first()
    if user is None or not user.is_active:
        # Mismo coste que con usuario real para no revelar qué emails existen
        verify_password(password, _dummy_hash())
        raise _invalid_credentials()

    now = utcnow()
    if user.locked_until and user.locked_until > now:
        raise AppError(
            423, "ACCOUNT_LOCKED", "Cuenta bloqueada por intentos fallidos. Prueba más tarde."
        )

    if not verify_password(password, user.password_hash):
        user.failed_logins += 1
        if user.failed_logins >= settings.max_failed_logins:
            user.locked_until = now + timedelta(minutes=settings.lockout_minutes)
            user.failed_logins = 0
            audit(session, "auth.bloqueo", tenant_id=user.tenant_id, user_id=user.id)
        session.add(user)
        session.commit()
        raise _invalid_credentials()

    if user.tenant_id:
        tenant = session.get(Tenant, user.tenant_id)
        if tenant is None or tenant.status == TenantStatus.DISABLED:
            raise AppError(403, "TENANT_DISABLED", "Tu empresa está desactivada.")

    if user.totp_enabled:
        if not totp_code:
            raise AppError(401, "TOTP_REQUIRED", "Introduce el código de verificación.")
        secret = decrypt_secret(user.totp_secret_enc or "")
        if not secret or not verify_totp(secret, totp_code):
            raise AppError(401, "TOTP_INVALID", "El código de verificación no es correcto.")

    user.failed_logins = 0
    user.locked_until = None
    user.last_login_at = now
    session.add(user)
    if user.tenant_id:
        tenant = session.get(Tenant, user.tenant_id)
        if tenant:
            tenant.last_activity_at = now
            session.add(tenant)
    audit(session, "auth.login", tenant_id=user.tenant_id, user_id=user.id)
    session.commit()
    return user


def open_session(session: Session, user: User, user_agent: str) -> tuple[str, str]:
    """Crea la sesión y devuelve (access token, refresh token)."""
    refresh, refresh_hash = new_opaque_token()
    session.add(
        AuthSession(
            user_id=user.id,
            token_hash=refresh_hash,
            expires_at=utcnow() + timedelta(days=settings.jwt_refresh_expire_days),
            user_agent=user_agent[:300],
        )
    )
    session.commit()
    return create_access_token(user.id, user.tenant_id), refresh


def rotate_session(session: Session, refresh_token: str) -> tuple[str, str]:
    """Cambia el refresh token por uno nuevo. Reusar uno ya rotado cierra todas
    las sesiones del usuario (señal de robo del token)."""
    row = session.exec(
        select(AuthSession).where(AuthSession.token_hash == hash_token(refresh_token))
    ).first()
    now = utcnow()
    if row is None or row.expires_at < now:
        raise AppError(401, "UNAUTHORIZED", "Sesión caducada.")
    if row.revoked_at is not None:
        revoke_all(session, row.user_id)
        raise AppError(401, "UNAUTHORIZED", "Sesión caducada.")

    user = session.get(User, row.user_id)
    if user is None or not user.is_active:
        raise AppError(401, "UNAUTHORIZED", "Sesión caducada.")
    if user.tenant_id:
        tenant = session.get(Tenant, user.tenant_id)
        if tenant is None or tenant.status == TenantStatus.DISABLED:
            raise AppError(403, "TENANT_DISABLED", "Tu empresa está desactivada.")

    new_refresh, new_hash = new_opaque_token()
    row.revoked_at = now
    session.add(row)
    session.add(
        AuthSession(
            user_id=user.id,
            token_hash=new_hash,
            expires_at=row.expires_at,
            user_agent=row.user_agent,
            last_used_at=now,
        )
    )
    session.commit()
    return create_access_token(user.id, user.tenant_id), new_refresh


def revoke(session: Session, refresh_token: str) -> None:
    row = session.exec(
        select(AuthSession).where(AuthSession.token_hash == hash_token(refresh_token))
    ).first()
    if row and row.revoked_at is None:
        row.revoked_at = utcnow()
        session.add(row)
        session.commit()


def revoke_all(session: Session, user_id: UUID) -> None:
    session.exec(
        update(AuthSession)
        .where(col(AuthSession.user_id) == user_id, col(AuthSession.revoked_at).is_(None))
        .values(revoked_at=utcnow())
    )
    session.commit()


def validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise bad_request(
            "WEAK_PASSWORD",
            f"La contraseña debe tener al menos {MIN_PASSWORD_LENGTH} caracteres.",
            "password",
        )


def create_action_token(session: Session, user: User, purpose: ActionPurpose) -> str:
    # Invalida enlaces anteriores del mismo tipo
    session.exec(
        update(ActionToken)
        .where(
            col(ActionToken.user_id) == user.id,
            col(ActionToken.purpose) == purpose,
            col(ActionToken.used_at).is_(None),
        )
        .values(used_at=utcnow())
    )
    token, token_hash = new_opaque_token()
    lifetime = (
        timedelta(days=INVITE_DAYS)
        if purpose == ActionPurpose.INVITE
        else timedelta(hours=RESET_HOURS)
    )
    session.add(
        ActionToken(
            user_id=user.id,
            purpose=purpose,
            token_hash=token_hash,
            expires_at=utcnow() + lifetime,
        )
    )
    return token


def get_action_token(session: Session, token: str, purpose: ActionPurpose) -> ActionToken:
    row = session.exec(
        select(ActionToken).where(
            ActionToken.token_hash == hash_token(token), ActionToken.purpose == purpose
        )
    ).first()
    if row is None or row.used_at is not None or row.expires_at < utcnow():
        raise bad_request("INVALID_TOKEN", "El enlace no es válido o ha caducado.")
    return row


def send_invitation(session: Session, user: User, tenant_name: str | None) -> None:
    """Guarda los cambios pendientes, genera el enlace de invitación y envía el email.

    El enlace va en una tabla de sistema (sin empresa), así que se crea con una
    sesión propia aunque quien invita use una sesión aislada por empresa.
    """
    session.commit()
    with new_session(bypass_rls=True) as system:
        token = create_action_token(system, user, ActionPurpose.INVITE)
        system.commit()
    url = f"{settings.app_url}/invitacion?token={token}"
    where = f" en {tenant_name}" if tenant_name else ""
    html = render(
        "Te han invitado a Konygest",
        [
            f"Hola {user.full_name}, te han dado acceso a Konygest{where}.",
            f"Crea tu contraseña para entrar. El enlace caduca en {INVITE_DAYS} días.",
        ],
        ("Crear contraseña", url),
    )
    send_email(user.tenant_id, user.email, "Invitación a Konygest", html)


def send_password_reset(session: Session, email: str) -> None:
    user = session.exec(select(User).where(User.email == email.lower().strip())).first()
    if user is None or not user.is_active or user.password_hash is None:
        return  # No revelamos si el email existe
    token = create_action_token(session, user, ActionPurpose.RESET_PASSWORD)
    url = f"{settings.app_url}/restablecer?token={token}"
    html = render(
        "Restablecer tu contraseña",
        [
            "Hemos recibido una solicitud para cambiar tu contraseña.",
            f"El enlace caduca en {RESET_HOURS} horas. Si no has sido tú, ignora este correo.",
        ],
        ("Cambiar contraseña", url),
    )
    session.commit()
    send_email(user.tenant_id, user.email, "Restablecer contraseña de Konygest", html)


def set_password_with_token(
    session: Session, token: str, password: str, purpose: ActionPurpose
) -> User:
    validate_password(password)
    row = get_action_token(session, token, purpose)
    user = session.get(User, row.user_id)
    if user is None or not user.is_active:
        raise bad_request("INVALID_TOKEN", "El enlace no es válido o ha caducado.")
    user.password_hash = hash_password(password)
    user.failed_logins = 0
    user.locked_until = None
    row.used_at = utcnow()
    session.add_all([user, row])
    audit(session, f"auth.{purpose.value}", tenant_id=user.tenant_id, user_id=user.id)
    session.commit()
    # Cambiar la contraseña cierra las demás sesiones
    revoke_all(session, user.id)
    return user
