"""Interfaz común de los destinos de documentos y utilidades compartidas.

Cada proveedor recibe rutas relativas a su carpeta raíz (`Albaranes/2026/ALB-2026-0001.pdf`)
y devuelve una **ubicación** opaca (id de fichero en Drive, `driveId/itemId` en OneDrive,
ruta UNC en SMB o clave en el almacenamiento de Konygest) que se guarda en `stored_document`
y basta para leer o borrar el fichero después, aunque cambien los ajustes de la empresa.
"""

from __future__ import annotations

import hashlib
import time
import uuid
from collections.abc import Callable
from typing import Protocol

import httpx

HTTP_TIMEOUT = httpx.Timeout(20.0, connect=10.0)

# Transporte HTTP inyectable (los tests ponen un httpx.MockTransport y no hay red)
_transport: httpx.BaseTransport | None = None


def set_http_transport(transport: httpx.BaseTransport | None) -> None:
    global _transport
    _transport = transport


def http_client() -> httpx.Client:
    return httpx.Client(timeout=HTTP_TIMEOUT, transport=_transport, follow_redirects=True)


class StorageProviderError(Exception):
    """Fallo del destino. `message` es apto para el usuario (en castellano y sin secretos)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class DocumentMissingError(StorageProviderError):
    """El fichero ya no está en el destino (borrado a mano, papelera vaciada…)."""

    def __init__(self, message: str = "El fichero no está en el destino.") -> None:
        super().__init__(message)


class StorageProvider(Protocol):
    name: str
    # Nuevo secreto si el proveedor lo ha renovado (refresh token rotado); se guarda después
    rotated_secret: str | None

    def save(self, path: str, data: bytes, content_type: str) -> str: ...
    def load(self, location: str) -> bytes: ...
    def delete(self, location: str) -> None: ...
    def test(self) -> None: ...


def split_path(path: str) -> list[str]:
    """Segmentos de una ruta relativa, rechazando `..` y vacíos."""
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    if not parts or any(p in (".", "..") for p in parts):
        raise StorageProviderError("Ruta de documento no válida.")
    return parts


def round_trip_test(provider: StorageProvider) -> None:
    """Escribe, lee y borra un fichero de prueba en la raíz del destino."""
    payload = f"Prueba de conexión de Konygest {uuid.uuid4()}".encode()
    location = provider.save(f"prueba-konygest-{uuid.uuid4().hex[:8]}.txt", payload, "text/plain")
    try:
        if provider.load(location) != payload:
            raise StorageProviderError("El fichero de prueba se leyó distinto de como se escribió.")
    finally:
        provider.delete(location)


def timed(fn: Callable[[], None]) -> int:
    """Ejecuta `fn` y devuelve los milisegundos que ha tardado."""
    start = time.perf_counter()
    fn()
    return int((time.perf_counter() - start) * 1000)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def http_error(service: str, exc: Exception) -> StorageProviderError:
    """Traduce un error de red de httpx a un mensaje para el usuario."""
    if isinstance(exc, httpx.TimeoutException):
        return StorageProviderError(f"{service} no responde (tiempo de espera agotado).")
    return StorageProviderError(f"No se pudo conectar con {service}.")
