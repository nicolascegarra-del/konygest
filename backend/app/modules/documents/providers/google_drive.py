"""Google Drive (API v3 por REST con httpx).

- El access token se obtiene con el refresh token de la empresa en cada instancia (dura 1 h;
  una instancia vive lo que una operación).
- Ámbito `drive.file`: la app solo ve lo que ha creado ella. Por eso las carpetas se buscan por
  nombre y carpeta padre antes de crearlas: las que creó Konygest se encuentran, y si el usuario
  crea a mano una carpeta con el mismo nombre, Konygest no la ve y crea la suya.
- `shared_drive_id`: unidad compartida opcional (todas las llamadas con `supportsAllDrives`).
- Ubicación guardada: el id del fichero.
"""

from __future__ import annotations

import contextlib
import json
import uuid
from typing import Any

import httpx

from app.modules.documents.providers.base import (
    DocumentMissingError,
    StorageProviderError,
    http_client,
    http_error,
    round_trip_test,
    split_path,
)

TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105
API = "https://www.googleapis.com/drive/v3"
UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"
FOLDER_MIME = "application/vnd.google-apps.folder"
SERVICE = "Google Drive"


def _quote(value: str) -> str:
    """Escapa un literal para la sintaxis de búsqueda `q` de Drive."""
    return value.replace("\\", "\\\\").replace("'", "\\'")


def _file_id(location: str) -> str:
    if not location or not all(c.isalnum() or c in "-_" for c in location):
        raise StorageProviderError("Ubicación de documento no válida.")
    return location


class GoogleDriveProvider:
    name = "google_drive"

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        root_folder_name: str = "Konygest",
        shared_drive_id: str | None = None,
    ) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.refresh_token = refresh_token
        self.root_folder_name = root_folder_name or "Konygest"
        self.shared_drive_id = shared_drive_id or None
        self.rotated_secret: str | None = None
        self._access_token: str | None = None
        self._folders: dict[tuple[str, str], str] = {}

    # ─── HTTP ─────────────────────────────────────────

    def _token(self, client: httpx.Client) -> str:
        if self._access_token:
            return self._access_token
        try:
            r = client.post(
                TOKEN_URL,
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": self.refresh_token,
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                },
            )
        except httpx.HTTPError as exc:
            raise http_error(SERVICE, exc) from exc
        if r.status_code in (400, 401):
            raise StorageProviderError(
                "La conexión con Google ha caducado o se ha revocado: vuelve a conectar la cuenta."
            )
        if r.status_code >= 400:
            raise StorageProviderError("Google no ha aceptado la conexión; inténtalo más tarde.")
        body = r.json()
        self._access_token = body["access_token"]
        if body.get("refresh_token") and body["refresh_token"] != self.refresh_token:
            self.rotated_secret = self.refresh_token = body["refresh_token"]
        return self._access_token  # type: ignore[return-value]

    def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        with http_client() as client:
            headers = {
                "Authorization": f"Bearer {self._token(client)}",
                **kwargs.pop("headers", {}),
            }
            params = {"supportsAllDrives": "true", **kwargs.pop("params", {})}
            try:
                r = client.request(method, url, headers=headers, params=params, **kwargs)
            except httpx.HTTPError as exc:
                raise http_error(SERVICE, exc) from exc
        if r.status_code == 404:
            raise DocumentMissingError("El fichero no está en Google Drive.")
        if r.status_code == 507 or (r.status_code == 403 and "storageQuota" in r.text):
            raise StorageProviderError("La cuenta de Google Drive no tiene espacio libre.")
        if r.status_code == 429 or (r.status_code == 403 and "ratelimitexceeded" in r.text.lower()):
            raise StorageProviderError(
                "Google Drive está limitando las peticiones; inténtalo dentro de un rato."
            )
        if r.status_code in (401, 403):
            raise StorageProviderError(
                "Google Drive ha denegado el acceso: revisa la cuenta conectada y sus permisos."
            )
        if r.status_code >= 400:
            raise StorageProviderError(
                f"Google Drive ha respondido con un error ({r.status_code})."
            )
        return r

    # ─── Carpetas ────────────────────────────────────

    def _root_parent(self) -> str:
        return self.shared_drive_id or "root"

    def _find(self, name: str, parent: str, folder: bool) -> str | None:
        mime = f"mimeType = '{FOLDER_MIME}'" if folder else f"mimeType != '{FOLDER_MIME}'"
        params: dict[str, str] = {
            "q": f"name = '{_quote(name)}' and '{_quote(parent)}' in parents and {mime} "
            "and trashed = false",
            "fields": "files(id,name)",
            "pageSize": "10",
            "includeItemsFromAllDrives": "true",
        }
        if self.shared_drive_id:
            params |= {"corpora": "drive", "driveId": self.shared_drive_id}
        files = self._request("GET", f"{API}/files", params=params).json().get("files", [])
        return files[0]["id"] if files else None

    def _folder(self, name: str, parent: str) -> str:
        key = (parent, name)
        if key in self._folders:
            return self._folders[key]
        folder_id = self._find(name, parent, folder=True)
        if folder_id is None:
            r = self._request(
                "POST",
                f"{API}/files",
                params={"fields": "id"},
                json={"name": name, "mimeType": FOLDER_MIME, "parents": [parent]},
            )
            folder_id = r.json()["id"]
        self._folders[key] = folder_id
        return folder_id

    def folder_for(self, folders: list[str]) -> str:
        """Id de `<raíz>/<carpetas…>`, creando las que falten."""
        parent = self._folder(self.root_folder_name, self._root_parent())
        for name in folders:
            parent = self._folder(name, parent)
        return parent

    # ─── Interfaz ────────────────────────────────────

    def save(self, path: str, data: bytes, content_type: str) -> str:
        *folders, filename = split_path(path)
        parent = self.folder_for(folders)
        existing = self._find(filename, parent, folder=False)
        if existing:
            # Mismo nombre en la misma carpeta: se sustituye el contenido (sin duplicados)
            r = self._request(
                "PATCH",
                f"{UPLOAD_API}/files/{existing}",
                params={"uploadType": "media", "fields": "id"},
                headers={"Content-Type": content_type},
                content=data,
            )
            return r.json()["id"]
        boundary = f"konygest-{uuid.uuid4().hex}"
        metadata = json.dumps({"name": filename, "parents": [parent]})
        body = (
            (
                f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
                f"{metadata}\r\n"
                f"--{boundary}\r\nContent-Type: {content_type}\r\n\r\n"
            ).encode()
            + data
            + f"\r\n--{boundary}--\r\n".encode()
        )
        r = self._request(
            "POST",
            f"{UPLOAD_API}/files",
            params={"uploadType": "multipart", "fields": "id"},
            headers={"Content-Type": f"multipart/related; boundary={boundary}"},
            content=body,
        )
        return r.json()["id"]

    def load(self, location: str) -> bytes:
        return self._request(
            "GET", f"{API}/files/{_file_id(location)}", params={"alt": "media"}
        ).content

    def delete(self, location: str) -> None:
        with contextlib.suppress(DocumentMissingError):
            self._request("DELETE", f"{API}/files/{_file_id(location)}")

    def test(self) -> None:
        round_trip_test(self)
