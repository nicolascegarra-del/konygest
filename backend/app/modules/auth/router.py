from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, Request, Response
from sqlmodel import Session, select

from app.core.config import get_settings
from app.core.db import system_session
from app.core.deps import CurrentUserDep, load_current_user
from app.core.errors import AppError, bad_request
from app.core.ratelimit import rate_limit
from app.core.security import (
    decrypt_secret,
    encrypt_secret,
    new_totp_secret,
    totp_uri,
    verify_password,
    verify_totp,
)
from app.modules.auth import service
from app.modules.auth.models import ActionPurpose
from app.modules.auth.schemas import (
    EmailIn,
    InvitationOut,
    LoginIn,
    MeOut,
    TokenOut,
    TokenPasswordIn,
    TotpCodeIn,
    TotpDisableIn,
    TotpSetupOut,
)
from app.modules.platform.audit import audit
from app.modules.tenants.models import Tenant
from app.modules.users.models import User

router = APIRouter(prefix="/auth", tags=["Autenticación"])
settings = get_settings()

REFRESH_COOKIE = "kg_refresh"
COOKIE_PATH = "/api/v1/auth"

SystemDb = Annotated[Session, Depends(system_session)]
RefreshCookie = Annotated[str | None, Cookie(alias=REFRESH_COOKIE)]


class LoginOut(TokenOut):
    user: MeOut


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        REFRESH_COOKIE,
        token,
        max_age=settings.jwt_refresh_expire_days * 86400,
        httponly=True,
        secure=settings.app_env != "development",
        samesite="strict",
        path=COOKIE_PATH,
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, path=COOKIE_PATH)


@router.post(
    "/login",
    summary="Iniciar sesión",
    description="Si el usuario tiene 2FA y no envía `totp_code`, responde 401 `TOTP_REQUIRED`.",
    response_model=LoginOut,
    dependencies=[Depends(rate_limit("login", 20, 300))],
)
def login(data: LoginIn, request: Request, response: Response, db: SystemDb) -> LoginOut:
    user = service.authenticate(db, data.email, data.password, data.totp_code)
    access, refresh = service.open_session(db, user, request.headers.get("user-agent", ""))
    _set_refresh_cookie(response, refresh)
    current = load_current_user(user.id, user.tenant_id, support=False)
    return LoginOut(access_token=access, user=MeOut.from_current(current))


@router.post(
    "/refresh",
    summary="Renovar el access token con la cookie de sesión",
    response_model=TokenOut,
    dependencies=[Depends(rate_limit("refresh", 60, 60))],
)
def refresh(response: Response, db: SystemDb, token: RefreshCookie = None) -> TokenOut:
    if not token:
        raise AppError(401, "UNAUTHORIZED", "Sesión caducada.")
    try:
        access, new_refresh = service.rotate_session(db, token)
    except AppError:
        _clear_refresh_cookie(response)
        raise
    _set_refresh_cookie(response, new_refresh)
    return TokenOut(access_token=access)


@router.post("/logout", summary="Cerrar esta sesión", status_code=204)
def logout(response: Response, db: SystemDb, token: RefreshCookie = None) -> None:
    if token:
        service.revoke(db, token)
    _clear_refresh_cookie(response)


@router.post("/logout-all", summary="Cerrar todas mis sesiones", status_code=204)
def logout_all(user: CurrentUserDep, response: Response, db: SystemDb) -> None:
    service.revoke_all(db, user.id)
    _clear_refresh_cookie(response)


@router.post(
    "/forgot-password",
    summary="Enviar enlace para restablecer la contraseña",
    description="Responde siempre 204 para no revelar qué emails existen.",
    status_code=204,
    dependencies=[Depends(rate_limit("forgot", 5, 900))],
)
def forgot_password(data: EmailIn, db: SystemDb) -> None:
    service.send_password_reset(db, data.email)


@router.post("/reset-password", summary="Restablecer contraseña con el enlace", status_code=204)
def reset_password(data: TokenPasswordIn, db: SystemDb) -> None:
    service.set_password_with_token(db, data.token, data.password, ActionPurpose.RESET_PASSWORD)


@router.get(
    "/invitation",
    summary="Datos de una invitación",
    response_model=InvitationOut,
    dependencies=[Depends(rate_limit("invitation", 30, 300))],
)
def invitation(token: str, db: SystemDb) -> InvitationOut:
    row = service.get_action_token(db, token, ActionPurpose.INVITE)
    user = db.get(User, row.user_id)
    if user is None:
        raise bad_request("INVALID_TOKEN", "El enlace no es válido o ha caducado.")
    tenant = db.get(Tenant, user.tenant_id) if user.tenant_id else None
    return InvitationOut(
        email=user.email, full_name=user.full_name, tenant_name=tenant.name if tenant else None
    )


@router.post("/accept-invite", summary="Aceptar invitación y crear contraseña", status_code=204)
def accept_invite(data: TokenPasswordIn, db: SystemDb) -> None:
    service.set_password_with_token(db, data.token, data.password, ActionPurpose.INVITE)


def _load_user(db: Session, user_id) -> User:
    user = db.exec(select(User).where(User.id == user_id)).one()
    return user


@router.post(
    "/2fa/setup",
    summary="Generar el secreto de verificación en dos pasos",
    description=("Devuelve el secreto y la URI `otpauth://` del QR. Se activa con `/2fa/enable`."),
    response_model=TotpSetupOut,
)
def totp_setup(user: CurrentUserDep, db: SystemDb) -> TotpSetupOut:
    row = _load_user(db, user.id)
    if row.totp_enabled:
        raise bad_request("TOTP_ALREADY_ENABLED", "La verificación en dos pasos ya está activa.")
    secret = new_totp_secret()
    row.totp_secret_enc = encrypt_secret(secret)
    db.add(row)
    db.commit()
    return TotpSetupOut(secret=secret, otpauth_uri=totp_uri(secret, row.email))


@router.post("/2fa/enable", summary="Activar la verificación en dos pasos", status_code=204)
def totp_enable(data: TotpCodeIn, user: CurrentUserDep, db: SystemDb) -> None:
    row = _load_user(db, user.id)
    secret = decrypt_secret(row.totp_secret_enc or "")
    if not secret:
        raise bad_request("TOTP_NOT_SETUP", "Primero genera el código QR.")
    if not verify_totp(secret, data.code):
        raise bad_request("TOTP_INVALID", "El código de verificación no es correcto.", "code")
    row.totp_enabled = True
    db.add(row)
    audit(db, "auth.2fa_activado", tenant_id=row.tenant_id, user_id=row.id)
    db.commit()


@router.post("/2fa/disable", summary="Desactivar la verificación en dos pasos", status_code=204)
def totp_disable(data: TotpDisableIn, user: CurrentUserDep, db: SystemDb) -> None:
    row = _load_user(db, user.id)
    if row.platform_role is not None:
        raise bad_request("TOTP_MANDATORY", "El personal de Klyp debe tener 2FA.")
    if row.tenant_id:
        tenant = db.get(Tenant, row.tenant_id)
        if tenant and tenant.require_2fa:
            raise bad_request("TOTP_MANDATORY", "Tu empresa exige la verificación en dos pasos.")
    secret = decrypt_secret(row.totp_secret_enc or "")
    if (
        not verify_password(data.password, row.password_hash)
        or not secret
        or not verify_totp(secret, data.code)
    ):
        raise bad_request("INVALID_CREDENTIALS", "Contraseña o código incorrectos.")
    row.totp_enabled = False
    row.totp_secret_enc = None
    db.add(row)
    audit(db, "auth.2fa_desactivado", tenant_id=row.tenant_id, user_id=row.id)
    db.commit()
