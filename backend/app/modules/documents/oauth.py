"""Conexión de cuentas de Google y Microsoft (OAuth 2.0, flujo de código de autorización).

1. `start`: se firma un `state` (JWT de 10 min con tipo propio, empresa, usuario y proveedor) y
   se devuelve la URL de autorización del proveedor.
2. El navegador vuelve a la `callback` pública con `code` y `state`. Se verifica el `state`, se
   intercambia el código por un refresh token y se lee el email de la cuenta conectada.

Las credenciales de la plataforma (`GOOGLE_OAUTH_*`, `MICROSOFT_OAUTH_*`) son las de la app
registrada por Klyp; sin ellas el proveedor no se ofrece.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from urllib.parse import urlencode
from uuid import UUID

import httpx
import jwt

from app.core.config import get_settings
from app.core.security import JWT_ALGORITHM, utcnow
from app.modules.documents.providers import onedrive
from app.modules.documents.providers.base import http_client

STATE_TYPE = "storage_oauth"
STATE_MINUTES = 10
OAUTH_PROVIDERS = ("google_drive", "onedrive")

GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"  # noqa: S105
GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo"
GOOGLE_SCOPES = "https://www.googleapis.com/auth/drive.file openid email"


class OAuthError(Exception):
    """Fallo del flujo OAuth. `code` es lo que vuelve al frontend en `?error=`."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class OAuthState:
    tenant_id: UUID
    user_id: UUID
    provider: str
    support: bool
    sharepoint: bool = False


@dataclass(frozen=True)
class OAuthResult:
    refresh_token: str
    account: str


def is_configured(provider: str) -> bool:
    s = get_settings()
    if provider == "google_drive":
        return bool(s.google_oauth_client_id and s.google_oauth_client_secret)
    if provider == "onedrive":
        return bool(s.microsoft_oauth_client_id and s.microsoft_oauth_client_secret)
    return False


def redirect_uri(provider: str) -> str:
    return f"{get_settings().app_url}/api/v1/tenant/storage/oauth/{provider}/callback"


def create_state(
    tenant_id: UUID, user_id: UUID, provider: str, support: bool = False, sharepoint: bool = False
) -> str:
    now = utcnow()
    payload = {
        "type": STATE_TYPE,
        "tid": str(tenant_id),
        "sub": str(user_id),
        "prv": provider,
        "act": "support" if support else None,
        "sp": sharepoint,
        "iat": now,
        "exp": now + timedelta(minutes=STATE_MINUTES),
    }
    return jwt.encode(payload, get_settings().jwt_secret_key, algorithm=JWT_ALGORITHM)


def decode_state(token: str, provider: str) -> OAuthState:
    """Verifica firma, caducidad, tipo y proveedor del `state`."""
    try:
        payload = jwt.decode(token, get_settings().jwt_secret_key, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != STATE_TYPE or payload.get("prv") != provider:
            raise OAuthError("INVALID_STATE")
        return OAuthState(
            tenant_id=UUID(payload["tid"]),
            user_id=UUID(payload["sub"]),
            provider=provider,
            support=payload.get("act") == "support",
            sharepoint=payload.get("sp") is True,
        )
    except (jwt.PyJWTError, KeyError, ValueError, TypeError) as exc:
        raise OAuthError("INVALID_STATE") from exc


def authorize_url(provider: str, state: str, sharepoint: bool = False) -> str:
    s = get_settings()
    if provider == "google_drive":
        params = {
            "client_id": s.google_oauth_client_id,
            "redirect_uri": redirect_uri(provider),
            "response_type": "code",
            "scope": GOOGLE_SCOPES,
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
            "state": state,
        }
        return f"{GOOGLE_AUTHORIZE}?{urlencode(params)}"
    params = {
        "client_id": s.microsoft_oauth_client_id,
        "redirect_uri": redirect_uri(provider),
        "response_type": "code",
        "response_mode": "query",
        "scope": onedrive.SHAREPOINT_SCOPES if sharepoint else onedrive.SCOPES,
        "prompt": "select_account",
        "state": state,
    }
    tenant = s.microsoft_oauth_tenant or "common"
    return f"{onedrive.LOGIN}/{tenant}/oauth2/v2.0/authorize?{urlencode(params)}"


def _post_token(client: httpx.Client, url: str, data: dict[str, str]) -> dict[str, Any]:
    try:
        r = client.post(url, data=data)
    except httpx.HTTPError as exc:
        raise OAuthError("OAUTH_FAILED") from exc
    if r.status_code >= 400:
        raise OAuthError("OAUTH_FAILED")
    body = r.json()
    if not body.get("refresh_token") or not body.get("access_token"):
        # Sin refresh token no se puede guardar nada después (p. ej. falta access_type=offline)
        raise OAuthError("OAUTH_FAILED")
    return body


def _get_json(client: httpx.Client, url: str, access_token: str, **params: str) -> dict[str, Any]:
    try:
        r = client.get(url, headers={"Authorization": f"Bearer {access_token}"}, params=params)
    except httpx.HTTPError as exc:
        raise OAuthError("OAUTH_FAILED") from exc
    if r.status_code >= 400:
        raise OAuthError("OAUTH_FAILED")
    return r.json()


def exchange_code(provider: str, code: str, sharepoint: bool = False) -> OAuthResult:
    """Cambia el código por el refresh token y averigua el email de la cuenta."""
    s = get_settings()
    with http_client() as client:
        if provider == "google_drive":
            tokens = _post_token(
                client,
                GOOGLE_TOKEN,
                {
                    "grant_type": "authorization_code",
                    "code": code,
                    "client_id": s.google_oauth_client_id,
                    "client_secret": s.google_oauth_client_secret,
                    "redirect_uri": redirect_uri(provider),
                },
            )
            info = _get_json(client, GOOGLE_USERINFO, tokens["access_token"])
            account = info.get("email") or ""
        else:
            tokens = _post_token(
                client,
                onedrive.token_url(s.microsoft_oauth_tenant),
                {
                    "grant_type": "authorization_code",
                    "code": code,
                    "client_id": s.microsoft_oauth_client_id,
                    "client_secret": s.microsoft_oauth_client_secret,
                    "redirect_uri": redirect_uri(provider),
                    "scope": onedrive.SHAREPOINT_SCOPES if sharepoint else onedrive.SCOPES,
                },
            )
            me = _get_json(
                client,
                f"{onedrive.GRAPH}/me",
                tokens["access_token"],
                **{"$select": "mail,userPrincipalName"},
            )
            account = me.get("mail") or me.get("userPrincipalName") or ""
    return OAuthResult(refresh_token=tokens["refresh_token"], account=str(account)[:200])
