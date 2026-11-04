"""Destino de los documentos de cada empresa: configuración, proveedores y `store`/`fetch`.

El destino elegido es el **almacén principal**. Cada fichero queda registrado en
`stored_document` con dónde se guardó y de qué datos sale; si al pedirlo no está (o el destino
no responde) se regenera con los datos de la base de datos y se vuelve a guardar. Si al guardar
falla el destino, se guarda en el almacenamiento de Konygest y se avisa (`documentos_error`,
como mucho uno al día por empresa).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlmodel import Session, col, select

from app.core.config import get_settings
from app.core.security import decrypt_secret, encrypt_secret, utcnow
from app.modules.documents import oauth
from app.modules.documents.models import StoredDocument, TenantStorage
from app.modules.documents.providers.base import (
    StorageProvider,
    StorageProviderError,
    round_trip_test,
    sha256,
)
from app.modules.documents.providers.google_drive import GoogleDriveProvider
from app.modules.documents.providers.onedrive import OneDriveProvider
from app.modules.documents.providers.platform import PlatformProvider
from app.modules.documents.providers.smb import SmbProvider

logger = logging.getLogger("konygest.documents")

PROVIDERS = ("platform", "google_drive", "onedrive", "smb")

# Carpeta de cada tipo de documento en el destino
KIND_FOLDERS = {
    "delivery_note": "Albaranes",
    "loading_order": "Ordenes de carga",
    "invoice": "Facturas",
    "credit_note": "Abonos",
}

DEFAULT_SETTINGS: dict[str, dict[str, Any]] = {
    "platform": {},
    "google_drive": {"root_folder_name": "Konygest", "shared_drive_id": None},
    "onedrive": {"root_path": "/Konygest", "site_url": None},
    "smb": {
        "server": "",
        "share": "",
        "root_path": "Konygest",
        "username": "",
        "domain": None,
        "port": None,
    },
}

ALERT_INTERVAL = timedelta(days=1)
ALERT_LINK = "/ajustes/documentos"
CONFIG_PERMISSION = "empresa.configurar"


# ─── Configuración ─────────────────────────────────


def get_config(db: Session, tenant_id: UUID) -> TenantStorage | None:
    return db.exec(select(TenantStorage).where(TenantStorage.tenant_id == tenant_id)).first()


def get_or_create_config(db: Session, tenant_id: UUID) -> TenantStorage:
    row = get_config(db, tenant_id)
    if row is None:
        row = TenantStorage(tenant_id=tenant_id)
        db.add(row)
        db.flush()
    return row


def available_providers() -> list[str]:
    return [p for p in PROVIDERS if p not in oauth.OAUTH_PROVIDERS or oauth.is_configured(p)]


def provider_settings(row: TenantStorage | None, provider: str) -> dict[str, Any]:
    stored = (row.provider_settings or {}).get(provider, {}) if row else {}
    return {**DEFAULT_SETTINGS.get(provider, {}), **stored}


def secrets(row: TenantStorage | None) -> dict[str, str]:
    """Secretos descifrados por proveedor (nunca salen al cliente)."""
    if row is None or not row.secrets_enc:
        return {}
    raw = decrypt_secret(row.secrets_enc)
    if raw is None:
        # ENCRYPTION_KEY cambiada: hay que volver a conectar
        logger.warning("No se pueden descifrar los secretos de documentos de %s", row.tenant_id)
        return {}
    try:
        value = json.loads(raw)
    except ValueError:
        return {}
    return {k: v for k, v in value.items() if isinstance(v, str)} if isinstance(value, dict) else {}


def set_secret(row: TenantStorage, provider: str, value: str | None) -> None:
    values = secrets(row)
    if value:
        values[provider] = value
    else:
        values.pop(provider, None)
    row.secrets_enc = encrypt_secret(json.dumps(values)) if values else None


def set_provider_settings(row: TenantStorage, provider: str, values: dict[str, Any]) -> None:
    # Reasignar el dict entero: SQLAlchemy no detecta cambios dentro de una columna JSON
    row.provider_settings = {**(row.provider_settings or {}), provider: values}


def set_account(row: TenantStorage, provider: str, account: str | None) -> None:
    accounts = dict(row.accounts or {})
    if account:
        accounts[provider] = account
    else:
        accounts.pop(provider, None)
    row.accounts = accounts


def has_secret(row: TenantStorage | None, provider: str) -> bool:
    return provider in secrets(row)


def build_provider(
    tenant_id: UUID,
    provider: str,
    settings_: dict[str, Any] | None = None,
    secret: str | None = None,
) -> StorageProvider:
    """Instancia el proveedor con sus ajustes y su secreto ya descifrado.

    Raises:
        StorageProviderError: si falta la conexión o la plataforma no tiene credenciales OAuth.
    """
    s = get_settings()
    values = {**DEFAULT_SETTINGS.get(provider, {}), **(settings_ or {})}
    if provider == "platform":
        return PlatformProvider(tenant_id)
    if provider in oauth.OAUTH_PROVIDERS and not oauth.is_configured(provider):
        raise StorageProviderError(
            "La plataforma no tiene configurada la conexión con este servicio."
        )
    if not secret:
        raise StorageProviderError("No hay ninguna cuenta conectada para este destino.")
    if provider == "google_drive":
        return GoogleDriveProvider(
            s.google_oauth_client_id,
            s.google_oauth_client_secret,
            secret,
            root_folder_name=values.get("root_folder_name") or "Konygest",
            shared_drive_id=values.get("shared_drive_id"),
        )
    if provider == "onedrive":
        return OneDriveProvider(
            s.microsoft_oauth_client_id,
            s.microsoft_oauth_client_secret,
            secret,
            tenant=s.microsoft_oauth_tenant,
            root_path=values.get("root_path") or "/Konygest",
            site_url=values.get("site_url"),
        )
    if provider == "smb":
        return SmbProvider(
            server=values.get("server") or "",
            share=values.get("share") or "",
            username=values.get("username") or "",
            password=secret,
            root_path=values.get("root_path") or "Konygest",
            domain=values.get("domain"),
            port=values.get("port"),
        )
    raise StorageProviderError("Destino de documentos desconocido.")


def provider_for(db: Session, tenant_id: UUID, provider: str) -> StorageProvider:
    """Proveedor con los ajustes y credenciales guardados de la empresa."""
    row = get_config(db, tenant_id)
    return build_provider(
        tenant_id, provider, provider_settings(row, provider), secrets(row).get(provider)
    )


def save_rotated_secret(db: Session, tenant_id: UUID, provider: StorageProvider) -> None:
    """Microsoft (y a veces Google) rotan el refresh token: se guarda el nuevo cifrado."""
    if not provider.rotated_secret:
        return
    row = get_config(db, tenant_id)
    if row is not None:
        set_secret(row, provider.name, provider.rotated_secret)
        db.add(row)
    provider.rotated_secret = None


def record_check(row: TenantStorage, error: str | None) -> None:
    row.status = "error" if error else "ok"
    row.last_error = error[:500] if error else None
    row.last_checked_at = utcnow()


def test_connection(provider: StorageProvider) -> None:
    """Escribe, lee y borra un fichero de prueba (lanza `StorageProviderError`)."""
    round_trip_test(provider)


# ─── Documentos ────────────────────────────────────


def document_path(kind: str, number: str, year: int, extension: str = "pdf") -> str:
    """`<Tipo>/<Año>/<número>.pdf`, relativo a la carpeta raíz del destino."""
    folder = KIND_FOLDERS.get(kind)
    if folder is None:
        raise ValueError(f"Tipo de documento desconocido: {kind}")
    if not number or any(c in number for c in "/\\") or number in (".", ".."):
        raise ValueError(f"Número de documento no válido: {number!r}")
    return f"{folder}/{year}/{number}.{extension}"


def find(db: Session, tenant_id: UUID, kind: str, number: str) -> StoredDocument | None:
    return db.exec(
        select(StoredDocument).where(
            StoredDocument.tenant_id == tenant_id,
            StoredDocument.kind == kind,
            StoredDocument.number == number,
        )
    ).first()


def numbers_stored(db: Session, tenant_id: UUID, kind: str, numbers: list[str]) -> set[str]:
    """Cuáles de esos números tienen documento guardado (una sola consulta)."""
    if not numbers:
        return set()
    rows = db.exec(
        select(StoredDocument.number).where(
            StoredDocument.tenant_id == tenant_id,
            StoredDocument.kind == kind,
            col(StoredDocument.number).in_(numbers),
        )
    ).all()
    return set(rows)


def _users_with_permission(db: Session, permission: str) -> list[UUID]:
    from app.modules.users.models import RolePermission, User, UserRole

    return sorted(
        set(
            db.exec(
                select(UserRole.user_id)
                .join(RolePermission, RolePermission.role_id == UserRole.role_id)
                .join(User, User.id == UserRole.user_id)
                .where(RolePermission.permission == permission, User.is_active)
                .distinct()
            ).all()
        )
    )


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _destination_failed(db: Session, row: TenantStorage, kind: str, number: str, msg: str) -> None:
    """Anota el fallo y avisa a quien configura la empresa (como mucho una vez al día)."""
    from app.modules.notifications.service import notify

    record_check(row, msg)
    now = utcnow()
    if row.last_alert_at is None or now - _as_utc(row.last_alert_at) >= ALERT_INTERVAL:
        row.last_alert_at = now
        recipients = _users_with_permission(db, CONFIG_PERMISSION)
        if recipients:
            notify(
                db,
                row.tenant_id,
                recipients,
                "documentos_error",
                "No se pudo guardar un documento en el destino configurado",
                f"{number}: {msg} Se ha guardado en el almacenamiento de Konygest; revisa la "
                "conexión en Ajustes › Documentos.",
                ALERT_LINK,
            )
    db.add(row)


def store(
    db: Session,
    tenant_id: UUID,
    kind: str,
    number: str,
    data: bytes,
    content_type: str = "application/pdf",
    source_type: str | None = None,
    source_id: UUID | None = None,
    *,
    year: int | None = None,
) -> StoredDocument:
    """Guarda el documento en el destino de la empresa y lo registra.

    Si ya hay uno con ese `kind` + `number`, lo sustituye (y borra, si puede, el fichero
    anterior cuando estaba en otro sitio). Si el destino falla, se guarda en el almacenamiento
    de Konygest (`provider="platform"`), se anota el error y se avisa. Los cambios en BD se
    confirman con el commit de quien llama.

    Raises:
        StorageProviderError: solo si falla también el almacenamiento de Konygest.
    """
    existing = find(db, tenant_id, kind, number)
    if year is None:
        year = _as_utc(existing.created_at).year if existing else utcnow().year
    path = document_path(kind, number, year)
    row = get_config(db, tenant_id)
    active = row.provider if row else "platform"

    provider_name, location = active, None
    if active != "platform":
        try:
            provider = provider_for(db, tenant_id, active)
            location = provider.save(path, data, content_type)
            save_rotated_secret(db, tenant_id, provider)
            if row is not None and row.status != "ok":
                record_check(row, None)
                db.add(row)
        except StorageProviderError as exc:
            logger.warning("Destino %s de %s caído: %s", active, tenant_id, exc.message)
            assert row is not None
            _destination_failed(db, row, kind, number, exc.message)
    if location is None:
        provider_name = "platform"
        location = PlatformProvider(tenant_id).save(path, data, content_type)

    if existing is not None and (existing.provider, existing.location) != (provider_name, location):
        _delete_quietly(db, tenant_id, existing.provider, existing.location)
    doc = existing or StoredDocument(
        tenant_id=tenant_id, kind=kind, number=number, filename="", provider="", location=""
    )
    doc.filename = path.rsplit("/", 1)[-1]
    doc.content_type = content_type
    doc.provider = provider_name
    doc.location = location
    doc.size = len(data)
    doc.sha256 = sha256(data)
    doc.source_type = source_type if source_type is not None else doc.source_type
    doc.source_id = source_id if source_id is not None else doc.source_id
    doc.updated_at = utcnow()
    db.add(doc)
    db.flush()
    return doc


def _delete_quietly(db: Session, tenant_id: UUID, provider: str, location: str) -> None:
    try:
        target = provider_for(db, tenant_id, provider)
        target.delete(location)
        save_rotated_secret(db, tenant_id, target)
    except Exception:  # noqa: BLE001 — el fichero viejo es prescindible
        logger.info("No se pudo borrar la copia anterior de un documento (%s)", provider)


def fetch(
    db: Session,
    tenant_id: UUID,
    kind: str,
    number: str,
    regenerate: Callable[[], bytes],
    *,
    content_type: str = "application/pdf",
    source_type: str | None = None,
    source_id: UUID | None = None,
) -> bytes:
    """Lee el documento de donde se guardó; si falta o el destino no responde, lo regenera
    con `regenerate()`, lo vuelve a guardar con `store` y lo devuelve.

    Las excepciones de `regenerate` (p. ej. `PdfUnavailableError`) se propagan.
    """
    doc = find(db, tenant_id, kind, number)
    if doc is not None:
        try:
            provider = provider_for(db, tenant_id, doc.provider)
            data = provider.load(doc.location)
            save_rotated_secret(db, tenant_id, provider)
            return data
        except StorageProviderError as exc:
            logger.info("Se regenera %s %s: %s", kind, number, exc.message)
    data = regenerate()
    store(
        db,
        tenant_id,
        kind,
        number,
        data,
        doc.content_type if doc else content_type,
        source_type or (doc.source_type if doc else None),
        source_id or (doc.source_id if doc else None),
    )
    return data
