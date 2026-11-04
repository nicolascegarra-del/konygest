"""Carpeta de red (SMB 2/3) con `smbclient` de smbprotocol.

- Cada operación abre su propia caché de conexiones y la cierra al terminar: así dos empresas
  que usen el mismo servidor nunca comparten una sesión autenticada con credenciales ajenas.
- Tiempo de espera corto (`CONNECTION_TIMEOUT`): si el NAS no responde, se falla rápido y el
  documento se guarda en el almacenamiento de Konygest.
- Ubicación guardada: la ruta UNC completa (`\\\\servidor\\recurso\\Konygest\\Albaranes\\…`).
  Solo se lee o borra si sigue dentro del servidor y recurso configurados (las credenciales
  nunca se envían a otro servidor); si no, se trata como fichero ausente y se regenera.
"""

from __future__ import annotations

import errno
import re
from collections.abc import Callable, Iterator
from contextlib import contextmanager, suppress
from typing import Any, TypeVar

from app.modules.documents.providers.base import (
    DocumentMissingError,
    StorageProviderError,
    round_trip_test,
    split_path,
)

CONNECTION_TIMEOUT = 10  # segundos
DEFAULT_PORT = 445

# Nombre de host, IPv4 o IPv6 entre corchetes; sin barras ni espacios
_HOST = re.compile(r"^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9][A-Za-z0-9.\-]*)$")
_SHARE = re.compile(r"^[^\\/:*?\"<>|]+$")

T = TypeVar("T")

# Cliente SMB inyectable (los tests ponen uno falso y no hay red)
_client: Any | None = None


def set_smb_client(client: Any | None) -> None:
    global _client
    _client = client


def _smb() -> Any:
    if _client is not None:
        return _client
    import smbclient

    return smbclient


def valid_host(value: str) -> bool:
    return bool(_HOST.match(value))


def valid_share(value: str) -> bool:
    return bool(_SHARE.match(value))


class SmbProvider:
    name = "smb"

    def __init__(
        self,
        server: str,
        share: str,
        username: str,
        password: str,
        root_path: str = "Konygest",
        domain: str | None = None,
        port: int | None = None,
    ) -> None:
        if not valid_host(server) or not valid_share(share):
            raise StorageProviderError("El servidor o el recurso compartido no son válidos.")
        self.server = server
        self.share = share
        self.username = f"{domain}\\{username}" if domain else username
        self.password = password
        self.root_parts = split_path(root_path) if root_path.strip("/\\ ") else []
        self.port = port or DEFAULT_PORT
        self.rotated_secret: str | None = None

    # ─── Rutas ──────────────────────────────────────

    @property
    def base(self) -> str:
        return f"\\\\{self.server}\\{self.share}"

    def unc(self, parts: list[str]) -> str:
        return "\\".join([self.base, *self.root_parts, *parts])

    def _own(self, location: str) -> str:
        """Comprueba que la ubicación está dentro del servidor y recurso configurados."""
        prefix = self.base.lower() + "\\"
        if not location.lower().startswith(prefix):
            raise DocumentMissingError("El fichero está en otra carpeta de red.")
        rest = location[len(prefix) :]
        split_path(rest)  # rechaza `..` y segmentos vacíos
        return location

    # ─── Conexión ───────────────────────────────────

    @contextmanager
    def _session(self) -> Iterator[dict[str, Any]]:
        smb = _smb()
        cache: dict[str, Any] = {}
        kwargs = {
            "username": self.username,
            "password": self.password,
            "port": self.port,
            "connection_timeout": CONNECTION_TIMEOUT,
            "connection_cache": cache,
        }
        try:
            yield kwargs
        finally:
            # Cerrar nunca debe tapar el error real
            with suppress(Exception):
                smb.reset_connection_cache(fail_on_error=False, connection_cache=cache)

    def _run(self, fn: Callable[[Any, dict[str, Any]], T]) -> T:
        with self._session() as kwargs:
            try:
                return fn(_smb(), kwargs)
            except StorageProviderError:
                raise
            except Exception as exc:
                raise self._translate(exc) from exc

    def _translate(self, exc: Exception) -> StorageProviderError:
        """Errores de smbprotocol y de red → mensaje para el usuario, sin secretos."""
        from smbprotocol.exceptions import SMBAuthenticationError, SMBOSError

        if isinstance(exc, SMBAuthenticationError):
            return StorageProviderError(
                "La carpeta de red ha rechazado el usuario o la contraseña."
            )
        if isinstance(exc, SMBOSError | FileNotFoundError):
            code = getattr(exc, "errno", None)
            if code == errno.ENOENT or isinstance(exc, FileNotFoundError):
                return DocumentMissingError("El fichero no está en la carpeta de red.")
            if code in (errno.EACCES, errno.EPERM):
                return StorageProviderError(
                    "El usuario no tiene permiso de escritura en la carpeta de red."
                )
            if code == errno.ENOSPC:
                return StorageProviderError("La carpeta de red no tiene espacio libre.")
            return StorageProviderError(
                f"La carpeta de red ha devuelto un error ({type(exc).__name__})."
            )
        if isinstance(exc, TimeoutError):
            return StorageProviderError(
                f"El servidor {self.server} no responde (tiempo de espera agotado)."
            )
        if isinstance(exc, OSError | ValueError):
            # ValueError: smbprotocol no consigue negociar la conexión (p. ej. puerto cerrado)
            return StorageProviderError(f"No se pudo conectar con el servidor {self.server}.")
        return StorageProviderError(f"No se pudo usar la carpeta de red ({type(exc).__name__}).")

    # ─── Interfaz ───────────────────────────────────

    def save(self, path: str, data: bytes, content_type: str) -> str:
        *folders, filename = split_path(path)
        target = self.unc([*folders, filename])

        def write(smb: Any, kwargs: dict[str, Any]) -> str:
            if self.root_parts or folders:
                smb.makedirs(self.unc(folders), exist_ok=True, **kwargs)
            with smb.open_file(target, mode="wb", **kwargs) as fh:
                fh.write(data)
            return target

        return self._run(write)

    def load(self, location: str) -> bytes:
        target = self._own(location)

        def read(smb: Any, kwargs: dict[str, Any]) -> bytes:
            with smb.open_file(target, mode="rb", **kwargs) as fh:
                return fh.read()

        return self._run(read)

    def delete(self, location: str) -> None:
        target = self._own(location)
        with suppress(DocumentMissingError):
            self._run(lambda smb, kwargs: smb.remove(target, **kwargs))

    def test(self) -> None:
        round_trip_test(self)
