"""OneDrive / SharePoint (Microsoft Graph con httpx).

- Access token a partir del refresh token de la empresa. Microsoft rota el refresh token: el
  nuevo queda en `rotated_secret` y el servicio lo guarda cifrado.
- Subida simple `PUT …/root:/{ruta}:/content`, que crea las carpetas de la ruta. **Límite de
  4 MB por fichero** (los albaranes y facturas ocupan decenas de KB); por encima se lanza
  `StorageProviderError` y el documento se guarda en el almacenamiento de Konygest.
- `site_url` (p. ej. `https://empresa.sharepoint.com/sites/Oficina`): se resuelve el sitio y
  se usa su biblioteca de documentos por defecto. Sin él, el OneDrive de la cuenta conectada.
- Ubicación guardada: `"<driveId>/<itemId>"`, válida aunque cambien la ruta o el sitio.
"""

from __future__ import annotations

import contextlib
from typing import Any
from urllib.parse import quote, urlparse

import httpx

from app.modules.documents.providers.base import (
    DocumentMissingError,
    StorageProviderError,
    http_client,
    http_error,
    round_trip_test,
    split_path,
)

GRAPH = "https://graph.microsoft.com/v1.0"
LOGIN = "https://login.microsoftonline.com"
SCOPES = "offline_access User.Read Files.ReadWrite"
SHAREPOINT_SCOPES = f"{SCOPES} Sites.ReadWrite.All"
MAX_SIMPLE_UPLOAD = 4 * 1024 * 1024
SERVICE = "OneDrive"


def token_url(tenant: str) -> str:
    return f"{LOGIN}/{quote(tenant or 'common', safe='')}/oauth2/v2.0/token"


def _segment_ok(value: str) -> bool:
    return bool(value) and all(c.isalnum() or c in "-_!.," for c in value)


class OneDriveProvider:
    name = "onedrive"

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        tenant: str = "common",
        root_path: str = "/Konygest",
        site_url: str | None = None,
    ) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.refresh_token = refresh_token
        self.tenant = tenant or "common"
        self.root_path = root_path or "/Konygest"
        self.site_url = site_url or None
        self.rotated_secret: str | None = None
        self._access_token: str | None = None
        self._drive_base: str | None = None

    def _token(self, client: httpx.Client) -> str:
        if self._access_token:
            return self._access_token
        try:
            r = client.post(
                token_url(self.tenant),
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": self.refresh_token,
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "scope": SHAREPOINT_SCOPES if self.site_url else SCOPES,
                },
            )
        except httpx.HTTPError as exc:
            raise http_error("Microsoft", exc) from exc
        if r.status_code in (400, 401):
            raise StorageProviderError(
                "La conexión con Microsoft ha caducado o se ha revocado: vuelve a conectar la "
                "cuenta."
            )
        if r.status_code >= 400:
            raise StorageProviderError("Microsoft no ha aceptado la conexión; inténtalo más tarde.")
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
            try:
                r = client.request(method, url, headers=headers, **kwargs)
            except httpx.HTTPError as exc:
                raise http_error(SERVICE, exc) from exc
        if r.status_code == 404:
            raise DocumentMissingError("El fichero o la carpeta no está en OneDrive.")
        if r.status_code in (401, 403):
            raise StorageProviderError(
                "OneDrive ha denegado el acceso: revisa la cuenta conectada y sus permisos."
            )
        if r.status_code == 507:
            raise StorageProviderError("La cuenta de OneDrive no tiene espacio libre.")
        if r.status_code >= 400:
            raise StorageProviderError(f"OneDrive ha respondido con un error ({r.status_code}).")
        return r

    def drive_base(self) -> str:
        """`/me/drive` o la unidad por defecto del sitio de SharePoint."""
        if self._drive_base:
            return self._drive_base
        if not self.site_url:
            self._drive_base = f"{GRAPH}/me/drive"
            return self._drive_base
        parsed = urlparse(self.site_url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise StorageProviderError("La dirección del sitio de SharePoint no es válida.")
        site_path = quote(parsed.path.rstrip("/"), safe="/")
        url = (
            f"{GRAPH}/sites/{parsed.hostname}:{site_path}"
            if site_path
            else (f"{GRAPH}/sites/{parsed.hostname}")
        )
        try:
            site_id = self._request("GET", url, params={"$select": "id"}).json()["id"]
        except DocumentMissingError as exc:
            raise StorageProviderError("No se encuentra el sitio de SharePoint indicado.") from exc
        self._drive_base = f"{GRAPH}/sites/{quote(site_id, safe='')}/drive"
        return self._drive_base

    def item_path(self, path: str) -> str:
        parts = [*split_path(self.root_path), *split_path(path)]
        return "/".join(quote(p, safe="") for p in parts)

    def _item_url(self, location: str) -> str:
        drive_id, _, item_id = location.partition("/")
        if not (_segment_ok(drive_id) and _segment_ok(item_id)):
            raise StorageProviderError("Ubicación de documento no válida.")
        return f"{GRAPH}/drives/{drive_id}/items/{item_id}"

    def save(self, path: str, data: bytes, content_type: str) -> str:
        if len(data) > MAX_SIMPLE_UPLOAD:
            raise StorageProviderError("El documento supera los 4 MB que admite OneDrive aquí.")
        url = f"{self.drive_base()}/root:/{self.item_path(path)}:/content"
        item = self._request(
            "PUT", url, headers={"Content-Type": content_type}, content=data
        ).json()
        return f"{item['parentReference']['driveId']}/{item['id']}"

    def load(self, location: str) -> bytes:
        return self._request("GET", f"{self._item_url(location)}/content").content

    def delete(self, location: str) -> None:
        with contextlib.suppress(DocumentMissingError):
            self._request("DELETE", self._item_url(location))

    def test(self) -> None:
        round_trip_test(self)
