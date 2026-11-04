"""Almacenamiento de Konygest (carpeta del servidor o MinIO) como destino de documentos.

Claves `"<tenant_id>/<Tipo>/<Año>/<número>.pdf"` saneadas para `validate_key`
(sin espacios ni acentos: `Ordenes de carga` → `Ordenes-de-carga`).
"""

from __future__ import annotations

import re
import unicodedata
from uuid import UUID

from app.modules.documents.providers.base import (
    DocumentMissingError,
    StorageProviderError,
    round_trip_test,
    split_path,
)
from app.modules.documents.storage import InvalidStorageKeyError, validate_key
from app.modules.documents.storage import storage as platform_storage

_INVALID = re.compile(r"[^A-Za-z0-9_.\-]+")


def safe_segment(segment: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", segment).encode("ascii", "ignore").decode()
    clean = _INVALID.sub("-", ascii_text).strip("-.")
    return clean or "documento"


class PlatformProvider:
    name = "platform"

    def __init__(self, tenant_id: UUID) -> None:
        self.tenant_id = tenant_id
        self.rotated_secret: str | None = None

    def key_for(self, path: str) -> str:
        return validate_key(
            "/".join([str(self.tenant_id), *(safe_segment(p) for p in split_path(path))])
        )

    def _check_owner(self, location: str) -> str:
        # Una ubicación de otra empresa nunca se lee (defensa además de la RLS)
        try:
            validate_key(location)
        except InvalidStorageKeyError as exc:
            raise StorageProviderError("Ubicación de documento no válida.") from exc
        if not location.startswith(f"{self.tenant_id}/"):
            raise StorageProviderError("Ubicación de documento no válida.")
        return location

    def save(self, path: str, data: bytes, content_type: str) -> str:
        key = self.key_for(path)
        try:
            platform_storage.save(key, data, content_type)
        except OSError as exc:
            raise StorageProviderError(
                "No se pudo guardar en el almacenamiento de Konygest."
            ) from exc
        return key

    def load(self, location: str) -> bytes:
        key = self._check_owner(location)
        try:
            return platform_storage.load(key)
        except (FileNotFoundError, KeyError) as exc:
            raise DocumentMissingError() from exc

    def delete(self, location: str) -> None:
        platform_storage.delete(self._check_owner(location))

    def test(self) -> None:
        round_trip_test(self)
