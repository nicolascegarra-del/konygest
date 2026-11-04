"""Rutas del destino de documentos de la empresa (`docs/api-documentos.md`)."""

import time
from typing import Annotated, Literal
from urllib.parse import urlencode
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Query, Response
from fastapi.responses import RedirectResponse
from sqlmodel import Session, col, select

from app.core.config import get_settings
from app.core.db import new_session
from app.core.deps import CurrentUser, TenantDbDep, load_current_user, require_permission
from app.core.errors import AppError, bad_request
from app.core.pagination import Page, PageDep, paginate
from app.core.ratelimit import rate_limit
from app.core.security import utcnow
from app.modules.documents import oauth, service
from app.modules.documents.models import StoredDocument, TenantStorage
from app.modules.documents.providers.base import StorageProviderError
from app.modules.documents.schemas import (
    OAuthStartOut,
    StorageTestOut,
    StorageUpdate,
    StoredDocumentOut,
    TenantStorageOut,
)
from app.modules.platform.audit import audit
from app.modules.users.models import User

router = APIRouter(prefix="/tenant/storage", tags=["Documentos"])

ConfigUser = Depends(require_permission(service.CONFIG_PERMISSION))
OAuthProviderPath = Literal["google_drive", "onedrive"]
PAGE_PATH = "/ajustes/documentos"

_ERRORS = {
    400: {"description": "`PROVIDER_NOT_CONFIGURED`, `NOT_CONNECTED`, `STORAGE_CONNECTION_FAILED`"},
    403: {"description": "Sin permiso `empresa.configurar`"},
}


def _out(db: Session, row: TenantStorage | None) -> TenantStorageOut:
    provider = row.provider if row else "platform"
    updated_by = db.get(User, row.updated_by) if row and row.updated_by else None
    return TenantStorageOut(
        provider=provider,
        settings=service.provider_settings(row, provider) if provider != "platform" else {},
        connected_account=(row.accounts or {}).get(provider) if row else None,
        has_secret=service.has_secret(row, provider),
        status=row.status if row else "not_configured",  # type: ignore[arg-type]
        last_error=row.last_error if row else None,
        last_checked_at=row.last_checked_at if row else None,
        updated_at=row.updated_at if row else None,
        updated_by_name=updated_by.full_name if updated_by else None,
        available_providers=service.available_providers(),
    )


def _not_configured() -> AppError:
    return bad_request(
        "PROVIDER_NOT_CONFIGURED", "Este destino no está disponible en la plataforma."
    )


def _touch(row: TenantStorage, user: CurrentUser) -> None:
    row.updated_at = utcnow()
    row.updated_by = user.id


@router.get(
    "",
    summary="Destino de los documentos",
    description="Configuración actual (sin secretos) y proveedores disponibles.",
    response_model=TenantStorageOut,
    responses={403: _ERRORS[403]},
)
def get_storage(db: TenantDbDep, user: CurrentUser = ConfigUser) -> TenantStorageOut:
    return _out(db, service.get_config(db, user.tenant_id))  # type: ignore[arg-type]


@router.put(
    "",
    summary="Guardar el destino de los documentos",
    description=(
        "Prueba la conexión antes de guardar (si falla: 400 `STORAGE_CONNECTION_FAILED` y no se "
        "guarda nada). Google Drive y OneDrive exigen haber conectado antes la cuenta "
        "(`NOT_CONNECTED`). En SMB, sin `password` se conserva la guardada si no cambian "
        "servidor, recurso ni usuario."
    ),
    response_model=TenantStorageOut,
    responses=_ERRORS,
)
def put_storage(
    data: Annotated[StorageUpdate, Body()], db: TenantDbDep, user: CurrentUser = ConfigUser
) -> TenantStorageOut:
    tenant_id: UUID = user.tenant_id  # type: ignore[assignment]
    provider = data.provider
    if provider not in service.available_providers():
        raise _not_configured()
    row = service.get_config(db, tenant_id)
    settings_ = data.settings.model_dump() if provider != "platform" else {}  # type: ignore[union-attr]

    secret: str | None = None
    new_password = False
    if provider in oauth.OAUTH_PROVIDERS:
        secret = service.secrets(row).get(provider)
        if not secret:
            raise bad_request("NOT_CONNECTED", "Conecta primero la cuenta con el botón «Conectar».")
    elif provider == "smb":
        password = getattr(data, "password", None)
        if password:
            secret, new_password = password, True
        else:
            # La contraseña guardada solo vale para el mismo servidor, recurso y usuario
            old = service.provider_settings(row, "smb")
            same = all(old.get(k) == settings_.get(k) for k in ("server", "share", "username"))
            secret = service.secrets(row).get("smb") if same else None
            if not secret:
                raise bad_request(
                    "VALIDATION_ERROR",
                    "Indica la contraseña (al cambiar de servidor o de usuario hay que volver "
                    "a escribirla).",
                    "password",
                )

    try:
        target = service.build_provider(tenant_id, provider, settings_, secret)
        service.test_connection(target)
    except StorageProviderError as exc:
        raise bad_request("STORAGE_CONNECTION_FAILED", exc.message) from exc

    row = row or service.get_or_create_config(db, tenant_id)
    if provider != "platform":
        service.set_provider_settings(row, provider, settings_)
    if new_password:
        service.set_secret(row, "smb", secret)
    if target.rotated_secret:
        service.set_secret(row, provider, target.rotated_secret)
    previous = row.provider
    row.provider = provider
    service.record_check(row, None)
    _touch(row, user)
    db.add(row)
    audit(
        db,
        "documentos.destino",
        user=user,
        entity="tenant_storage",
        entity_id=row.id,
        data={
            "proveedor": provider,
            "anterior": previous,
            "ajustes": settings_,
            "contraseña_cambiada": new_password,
        },
    )
    db.commit()
    return _out(db, row)


@router.delete(
    "",
    summary="Volver al almacenamiento de Konygest",
    description=(
        "Borra las credenciales y las cuentas conectadas. Los documentos ya guardados siguen en "
        "su destino; si ya no se pueden leer de allí, se regeneran al pedirlos."
    ),
    response_model=TenantStorageOut,
    responses={403: _ERRORS[403]},
)
def delete_storage(db: TenantDbDep, user: CurrentUser = ConfigUser) -> TenantStorageOut:
    row = service.get_or_create_config(db, user.tenant_id)  # type: ignore[arg-type]
    previous = row.provider
    row.provider = "platform"
    row.secrets_enc = None
    row.accounts = {}
    row.status, row.last_error = "ok", None
    _touch(row, user)
    db.add(row)
    audit(
        db,
        "documentos.desconectar",
        user=user,
        entity="tenant_storage",
        entity_id=row.id,
        data={"anterior": previous},
    )
    db.commit()
    return _out(db, row)


@router.post(
    "/test",
    summary="Probar el destino actual",
    description="Escribe, lee y borra un fichero de prueba. Actualiza `status` y `last_error`.",
    response_model=StorageTestOut,
    responses={403: _ERRORS[403]},
)
def test_storage(db: TenantDbDep, user: CurrentUser = ConfigUser) -> StorageTestOut:
    tenant_id: UUID = user.tenant_id  # type: ignore[assignment]
    row = service.get_config(db, tenant_id)
    provider_name = row.provider if row else "platform"
    start = time.perf_counter()
    try:
        provider = service.provider_for(db, tenant_id, provider_name)
        service.test_connection(provider)
        service.save_rotated_secret(db, tenant_id, provider)
        ok, message = (
            True,
            "Conexión correcta: se ha escrito, leído y borrado un fichero de prueba.",
        )
    except StorageProviderError as exc:
        ok, message = False, exc.message
    result = StorageTestOut(
        ok=ok, message=message, elapsed_ms=int((time.perf_counter() - start) * 1000)
    )
    row = row or service.get_or_create_config(db, tenant_id)
    service.record_check(row, None if result.ok else result.message)
    db.add(row)
    db.commit()
    return result


@router.post(
    "/oauth/{provider}/start",
    summary="Empezar a conectar una cuenta de Google o Microsoft",
    description=(
        "Devuelve la URL de autorización. El `state` es un JWT firmado de 10 minutos. Con "
        "`sharepoint=true` (o si ya hay un sitio de SharePoint guardado) se pide además "
        "`Sites.ReadWrite.All`."
    ),
    response_model=OAuthStartOut,
    responses=_ERRORS,
)
def oauth_start(
    provider: OAuthProviderPath,
    db: TenantDbDep,
    sharepoint: bool = False,
    user: CurrentUser = ConfigUser,
) -> OAuthStartOut:
    if not oauth.is_configured(provider):
        raise _not_configured()
    if provider == "onedrive" and not sharepoint:
        row = service.get_config(db, user.tenant_id)  # type: ignore[arg-type]
        sharepoint = bool(service.provider_settings(row, "onedrive").get("site_url"))
    state = oauth.create_state(
        user.tenant_id,  # type: ignore[arg-type]
        user.id,
        provider,
        support=user.support_mode,
        sharepoint=sharepoint and provider == "onedrive",
    )
    return OAuthStartOut(authorize_url=oauth.authorize_url(provider, state, sharepoint))


def _back(**params: str) -> RedirectResponse:
    url = f"{get_settings().app_url}{PAGE_PATH}?{urlencode(params)}"
    return RedirectResponse(url, status_code=303)


@router.get(
    "/oauth/{provider}/callback",
    summary="Vuelta de Google o Microsoft (pública)",
    description=(
        "La llama el navegador al volver del proveedor; se autentica por el `state`. Redirige a "
        "`{APP_URL}/ajustes/documentos?connected=<provider>` o `?error=<código>` "
        "(`access_denied`, `INVALID_STATE`, `OAUTH_FAILED`, `PROVIDER_NOT_CONFIGURED`, "
        "`FORBIDDEN`)."
    ),
    response_class=RedirectResponse,
    status_code=303,
    dependencies=[Depends(rate_limit("storage_oauth", 30, 300))],
)
def oauth_callback(
    provider: str,
    code: Annotated[str | None, Query(max_length=4000)] = None,
    state: Annotated[str | None, Query(max_length=4000)] = None,
    error: Annotated[str | None, Query(max_length=200)] = None,
) -> Response:
    if provider not in oauth.OAUTH_PROVIDERS:
        return _back(error="OAUTH_FAILED")
    try:
        st = oauth.decode_state(state or "", provider)
    except oauth.OAuthError as exc:
        return _back(error=exc.code)
    if error:
        return _back(error="access_denied" if error == "access_denied" else "OAUTH_FAILED")
    if not code:
        return _back(error="OAUTH_FAILED")
    if not oauth.is_configured(provider):
        return _back(error="PROVIDER_NOT_CONFIGURED")
    try:
        user = load_current_user(st.user_id, st.tenant_id, st.support)
    except AppError:
        return _back(error="INVALID_STATE")
    if not user.can(service.CONFIG_PERMISSION) or user.read_only:
        return _back(error="FORBIDDEN")
    try:
        result = oauth.exchange_code(provider, code, st.sharepoint)
    except oauth.OAuthError as exc:
        return _back(error=exc.code)

    with new_session(tenant_id=st.tenant_id) as db:
        row = service.get_or_create_config(db, st.tenant_id)
        service.set_secret(row, provider, result.refresh_token)
        service.set_account(row, provider, result.account)
        service.set_provider_settings(row, provider, service.provider_settings(row, provider))
        previous = row.provider
        # Conectar activa el destino: los documentos nuevos se guardan allí
        row.provider = provider
        row.status, row.last_error = "ok", None
        _touch(row, user)
        db.add(row)
        audit(
            db,
            "documentos.conectar",
            user=user,
            entity="tenant_storage",
            entity_id=row.id,
            data={"proveedor": provider, "cuenta": result.account, "anterior": previous},
        )
        db.commit()
    return _back(connected=provider)


@router.get(
    "/documents",
    summary="Documentos guardados",
    description="Paginado, del más reciente al más antiguo. `search` busca por número.",
    response_model=Page[StoredDocumentOut],
    responses={403: _ERRORS[403]},
)
def list_documents(
    db: TenantDbDep,
    page: PageDep,
    kind: Annotated[str | None, Query(max_length=30)] = None,
    search: Annotated[str | None, Query(max_length=100)] = None,
    _: CurrentUser = ConfigUser,
) -> Page[StoredDocumentOut]:
    query = select(StoredDocument)
    if kind:
        query = query.where(StoredDocument.kind == kind)
    if search and search.strip():
        term = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        query = query.where(col(StoredDocument.number).ilike(f"%{term}%", escape="\\"))
    query = query.order_by(col(StoredDocument.created_at).desc(), col(StoredDocument.number).desc())
    items, total = paginate(db, query, page)
    return Page(
        items=[StoredDocumentOut.model_validate(d, from_attributes=True) for d in items],
        total=total,
        offset=page.offset,
        limit=page.limit,
    )
