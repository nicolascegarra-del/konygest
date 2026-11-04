"""Esquemas de la API del destino de documentos (`docs/api-documentos.md`)."""

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, StringConstraints, field_validator

from app.modules.documents.providers.base import StorageProviderError, split_path
from app.modules.documents.providers.smb import valid_host, valid_share

Text = Annotated[str, StringConstraints(strip_whitespace=True)]


def _empty_to_none(value: Any) -> Any:
    return None if isinstance(value, str) and not value.strip() else value


def _check_path(value: str) -> str:
    try:
        split_path(value)
    except StorageProviderError as exc:
        raise ValueError("Ruta no válida.") from exc
    return value


class GoogleDriveSettingsIn(BaseModel):
    root_folder_name: Text = Field(default="Konygest", min_length=1, max_length=120)
    shared_drive_id: Text | None = Field(default=None, max_length=200, pattern=r"^[A-Za-z0-9_\-]+$")

    _none = field_validator("shared_drive_id", mode="before")(_empty_to_none)


class OneDriveSettingsIn(BaseModel):
    root_path: Text = Field(default="/Konygest", min_length=1, max_length=250)
    site_url: Text | None = Field(
        default=None, max_length=300, pattern=r"^https://[^\s/]+\.[^\s]+$"
    )

    _none = field_validator("site_url", mode="before")(_empty_to_none)
    _path = field_validator("root_path")(_check_path)


class SmbSettingsIn(BaseModel):
    server: Text = Field(min_length=1, max_length=255)
    share: Text = Field(min_length=1, max_length=255)
    root_path: Text = Field(default="Konygest", max_length=255)
    username: Text = Field(min_length=1, max_length=255)
    domain: Text | None = Field(default=None, max_length=255)
    port: int | None = Field(default=None, ge=1, le=65535)

    _none = field_validator("domain", "port", mode="before")(_empty_to_none)

    @field_validator("server")
    @classmethod
    def _server(cls, value: str) -> str:
        if not valid_host(value):
            raise ValueError("Indica el nombre o la IP del servidor, sin barras.")
        return value

    @field_validator("share")
    @classmethod
    def _share(cls, value: str) -> str:
        if not valid_share(value):
            raise ValueError("Indica solo el nombre del recurso compartido, sin barras.")
        return value

    @field_validator("root_path")
    @classmethod
    def _root(cls, value: str) -> str:
        value = value.strip("/\\ ") or "Konygest"
        return _check_path(value)


class PlatformUpdate(BaseModel):
    provider: Literal["platform"]
    settings: dict[str, Any] | None = None


class GoogleDriveUpdate(BaseModel):
    provider: Literal["google_drive"]
    settings: GoogleDriveSettingsIn = Field(default_factory=GoogleDriveSettingsIn)


class OneDriveUpdate(BaseModel):
    provider: Literal["onedrive"]
    settings: OneDriveSettingsIn = Field(default_factory=OneDriveSettingsIn)


class SmbUpdate(BaseModel):
    provider: Literal["smb"]
    settings: SmbSettingsIn
    # Vacío u omitido al editar = conservar la guardada (si no cambian servidor ni usuario)
    password: str | None = Field(default=None, max_length=500)


StorageUpdate = Annotated[
    PlatformUpdate | GoogleDriveUpdate | OneDriveUpdate | SmbUpdate,
    Field(discriminator="provider"),
]


class TenantStorageOut(BaseModel):
    provider: str
    settings: dict[str, Any] | None
    connected_account: str | None
    has_secret: bool
    status: Literal["ok", "error", "not_configured"]
    last_error: str | None
    last_checked_at: datetime | None
    updated_at: datetime | None
    updated_by_name: str | None
    available_providers: list[str]


class StorageTestOut(BaseModel):
    ok: bool
    message: str
    elapsed_ms: int


class OAuthStartOut(BaseModel):
    authorize_url: str


class StoredDocumentOut(BaseModel):
    id: UUID
    kind: str
    number: str
    filename: str
    provider: str
    size: int
    created_at: datetime
    source_type: str | None
    source_id: UUID | None
