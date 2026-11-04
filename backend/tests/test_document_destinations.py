"""Destinos de documentos por empresa: Google Drive, OneDrive y SMB (falsos, sin red),
OAuth, `PUT /tenant/storage`, `store`/`fetch` con caída del destino y regeneración, cambio
de destino, permisos, aislamiento entre empresas y albarán de logística por la nueva API."""

from __future__ import annotations

import io
import itertools
import json
import re
from collections.abc import Iterator
from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse
from uuid import UUID

import httpx
import jwt
import pytest
from smbprotocol.exceptions import SMBAuthenticationError, SMBOSError
from smbprotocol.header import NtStatus
from sqlmodel import select

from app.core.config import get_settings
from app.core.db import new_session
from app.core.security import create_access_token, decrypt_secret, utcnow
from app.modules import documents
from app.modules.documents import oauth, service
from app.modules.documents.models import StoredDocument, TenantStorage
from app.modules.documents.providers import base as providers_base
from app.modules.documents.providers import smb as smb_module
from app.modules.documents.providers.base import DocumentMissingError, StorageProviderError
from app.modules.documents.providers.google_drive import FOLDER_MIME, GoogleDriveProvider
from app.modules.documents.providers.onedrive import OneDriveProvider
from app.modules.documents.providers.smb import SmbProvider
from app.modules.notifications.models import Notification
from app.modules.platform.models import AuditLog
from tests.conftest import invite_user
from tests.test_logistics import (  # noqa: F401  (ctx es un fixture)
    act,
    body,
    create,
    ctx,
    make_order,
    silos,
    weigh_body,
)

API = "/api/v1/tenant/storage"
YEAR = utcnow().year
GOOGLE_RT = "rt-google-secreto"
SMB_PASSWORD = "clave-nas-secreta"


# ─── Almacenamiento de Konygest en memoria ─────────


class MemoryStorage:
    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}

    def save(self, key: str, data: bytes, content_type: str) -> None:
        self.files[key] = data

    def load(self, key: str) -> bytes:
        if key not in self.files:
            raise FileNotFoundError(key)
        return self.files[key]

    def exists(self, key: str) -> bool:
        return key in self.files

    def delete(self, key: str) -> None:
        self.files.pop(key, None)


@pytest.fixture(autouse=True)
def platform() -> Iterator[MemoryStorage]:
    mem = MemoryStorage()
    documents.storage.reset(mem)
    yield mem
    documents.storage.reset()


@pytest.fixture(autouse=True)
def oauth_env(monkeypatch) -> None:
    s = get_settings()
    monkeypatch.setattr(s, "google_oauth_client_id", "google-id")
    monkeypatch.setattr(s, "google_oauth_client_secret", "google-secret")
    monkeypatch.setattr(s, "microsoft_oauth_client_id", "ms-id")
    monkeypatch.setattr(s, "microsoft_oauth_client_secret", "ms-secret")
    monkeypatch.setattr(s, "microsoft_oauth_tenant", "common")


# ─── Google y Microsoft falsos (httpx.MockTransport) ─


class FakeGoogle:
    def __init__(self) -> None:
        self.items: dict[str, dict[str, Any]] = {}
        self.ids = (f"g{n}" for n in itertools.count(1))
        self.token_calls = 0
        self.rotate_to: str | None = None
        self.down = False
        self.valid_refresh = {GOOGLE_RT}

    def handle(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("caído", request=request)
        url = request.url
        if url.host == "oauth2.googleapis.com":
            form = parse_qs(request.content.decode())
            grant = form["grant_type"][0]
            if grant == "authorization_code":
                if form["code"][0] != "good-code" or form["client_secret"][0] != "google-secret":
                    return httpx.Response(400, json={"error": "invalid_grant"})
                return httpx.Response(
                    200, json={"access_token": "at-google", "refresh_token": GOOGLE_RT}
                )
            self.token_calls += 1
            if form["refresh_token"][0] not in self.valid_refresh:
                return httpx.Response(400, json={"error": "invalid_grant"})
            payload = {"access_token": "at-google", "expires_in": 3600}
            if self.rotate_to:
                payload["refresh_token"] = self.rotate_to
                self.valid_refresh.add(self.rotate_to)
            return httpx.Response(200, json=payload)
        if request.headers.get("Authorization") != "Bearer at-google":
            return httpx.Response(401)
        if url.host == "openidconnect.googleapis.com":
            return httpx.Response(200, json={"email": "oficina@piensosnorte.es"})
        path = url.path
        if path == "/drive/v3/files" and request.method == "GET":
            q = url.params["q"]
            name = re.search(r"name = '((?:[^'\\]|\\.)*)'", q).group(1).replace("\\'", "'")
            parent = re.search(r"'([^']*)' in parents", q).group(1)
            folder = f"mimeType = '{FOLDER_MIME}'" in q
            files = [
                {"id": i, "name": it["name"]}
                for i, it in self.items.items()
                if it["name"] == name
                and parent in it["parents"]
                and (it["mime"] == FOLDER_MIME) == folder
            ]
            return httpx.Response(200, json={"files": files})
        if path == "/drive/v3/files" and request.method == "POST":
            meta = json.loads(request.content)
            new_id = next(self.ids)
            self.items[new_id] = {
                "name": meta["name"],
                "parents": meta["parents"],
                "mime": meta["mimeType"],
                "content": b"",
            }
            return httpx.Response(200, json={"id": new_id})
        if path == "/upload/drive/v3/files" and request.method == "POST":
            boundary = request.headers["Content-Type"].split("boundary=")[1]
            parts = request.content.split(f"--{boundary}".encode())
            meta = json.loads(parts[1].split(b"\r\n\r\n", 1)[1])
            content = parts[2].split(b"\r\n\r\n", 1)[1][: -len(b"\r\n")]
            new_id = next(self.ids)
            self.items[new_id] = {
                "name": meta["name"],
                "parents": meta["parents"],
                "mime": "application/pdf",
                "content": content,
            }
            return httpx.Response(200, json={"id": new_id})
        match = re.fullmatch(r"/(upload/)?drive/v3/files/([\w-]+)", path)
        if match:
            file_id = match.group(2)
            if file_id not in self.items:
                return httpx.Response(404)
            if request.method == "PATCH":
                self.items[file_id]["content"] = request.content
                return httpx.Response(200, json={"id": file_id})
            if request.method == "DELETE":
                del self.items[file_id]
                return httpx.Response(204)
            return httpx.Response(200, content=self.items[file_id]["content"])
        return httpx.Response(500)

    def path_of(self, item_id: str) -> str:
        parts = []
        while item_id in self.items:
            parts.append(self.items[item_id]["name"])
            item_id = self.items[item_id]["parents"][0]
        return "/".join(reversed(parts))

    def files(self) -> dict[str, bytes]:
        return {
            self.path_of(i): it["content"]
            for i, it in self.items.items()
            if it["mime"] != FOLDER_MIME
        }


class FakeGraph:
    def __init__(self) -> None:
        self.items: dict[str, dict[str, Any]] = {}
        self.ids = (f"item{n}" for n in itertools.count(1))
        self.refresh = "rt-ms-0"
        self.counter = itertools.count(1)
        self.scopes: list[str] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.host == "login.microsoftonline.com":
            form = parse_qs(request.content.decode())
            self.scopes.append(form["scope"][0])
            if form["grant_type"][0] == "authorization_code":
                if form["code"][0] != "good-code":
                    return httpx.Response(400, json={"error": "invalid_grant"})
            elif form["refresh_token"][0] != self.refresh:
                return httpx.Response(400, json={"error": "invalid_grant"})
            # Microsoft rota el refresh token en cada uso
            self.refresh = f"rt-ms-{next(self.counter)}"
            return httpx.Response(
                200, json={"access_token": "at-ms", "refresh_token": self.refresh}
            )
        if request.headers.get("Authorization") != "Bearer at-ms":
            return httpx.Response(401)
        path = url.path
        if path == "/v1.0/me":
            return httpx.Response(200, json={"mail": None, "userPrincipalName": "ana@norte.com"})
        if path == "/v1.0/sites/norte.sharepoint.com:/sites/Oficina":
            return httpx.Response(200, json={"id": "norte.sharepoint.com,1,2"})
        match = re.fullmatch(r"/v1\.0/(me/drive|sites/[^/]+/drive)/root:/(.+):/content", path)
        if match and request.method == "PUT":
            drive = "drv-me" if match.group(1) == "me/drive" else "drv-site"
            item_path = unquote(match.group(2))
            existing = next(
                (
                    i
                    for i, it in self.items.items()
                    if (it["drive"], it["path"]) == (drive, item_path)
                ),
                None,
            )
            item_id = existing or next(self.ids)
            self.items[item_id] = {"drive": drive, "path": item_path, "content": request.content}
            return httpx.Response(201, json={"id": item_id, "parentReference": {"driveId": drive}})
        match = re.fullmatch(r"/v1\.0/drives/([\w-]+)/items/([\w!-]+)(/content)?", path)
        if match:
            item = self.items.get(match.group(2))
            if item is None or item["drive"] != match.group(1):
                return httpx.Response(404)
            if request.method == "DELETE":
                del self.items[match.group(2)]
                return httpx.Response(204)
            return httpx.Response(200, content=item["content"])
        return httpx.Response(500)

    def files(self) -> dict[str, bytes]:
        return {f"{it['drive']}:{it['path']}": it["content"] for it in self.items.values()}


class Cloud:
    def __init__(self) -> None:
        self.google = FakeGoogle()
        self.ms = FakeGraph()

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.host in ("login.microsoftonline.com", "graph.microsoft.com"):
            return self.ms.handle(request)
        return self.google.handle(request)


@pytest.fixture(autouse=True)
def cloud() -> Iterator[Cloud]:
    fake = Cloud()
    providers_base.set_http_transport(httpx.MockTransport(fake.handle))
    yield fake
    providers_base.set_http_transport(None)


# ─── Carpeta SMB falsa ─────────────────────────────


class FakeSmb:
    """Imita `smbclient`: carpetas y ficheros en memoria, comprueba usuario y contraseña."""

    def __init__(self, username: str = "konygest", password: str = SMB_PASSWORD) -> None:
        self.username = username
        self.password = password
        self.dirs: set[str] = set()
        self.files: dict[str, bytes] = {}
        self.down = False
        self.logins: list[tuple[str, str]] = []
        self.caches_closed = 0

    def _check(self, kwargs: dict[str, Any]) -> None:
        assert kwargs["connection_timeout"] <= 15
        assert isinstance(kwargs["connection_cache"], dict)
        if self.down:
            raise ConnectionRefusedError("sin ruta")
        self.logins.append((kwargs["username"], kwargs["password"]))
        if (kwargs["username"], kwargs["password"]) != (self.username, self.password):
            raise SMBAuthenticationError("Failed to authenticate with server")

    @staticmethod
    def _missing(path: str) -> SMBOSError:
        return SMBOSError(NtStatus.STATUS_OBJECT_NAME_NOT_FOUND, path)

    def makedirs(self, path: str, exist_ok: bool = False, **kwargs: Any) -> None:
        self._check(kwargs)
        parts = path.split("\\")
        for n in range(5, len(parts) + 1):  # \\servidor\recurso\a\b → "", "", srv, share, a…
            self.dirs.add("\\".join(parts[:n]))

    def open_file(self, path: str, mode: str = "r", **kwargs: Any):
        self._check(kwargs)
        parent = path.rsplit("\\", 1)[0]
        if "w" in mode:
            if parent.count("\\") > 3 and parent not in self.dirs:
                raise self._missing(parent)
            files = self.files

            class Writer(io.BytesIO):
                def close(self) -> None:
                    files[path] = self.getvalue()
                    super().close()

            return Writer()
        if path not in self.files:
            raise self._missing(path)
        return io.BytesIO(self.files[path])

    def remove(self, path: str, **kwargs: Any) -> None:
        self._check(kwargs)
        if path not in self.files:
            raise self._missing(path)
        del self.files[path]

    def reset_connection_cache(self, fail_on_error: bool = True, connection_cache=None) -> None:
        self.caches_closed += 1


@pytest.fixture(autouse=True)
def nas() -> Iterator[FakeSmb]:
    fake = FakeSmb()
    smb_module.set_smb_client(fake)
    yield fake
    smb_module.set_smb_client(None)


SMB_SETTINGS = {
    "server": "nas.piensosnorte.es",
    "share": "documentos",
    "root_path": "Konygest",
    "username": "konygest",
    "domain": None,
    "port": None,
}


# ─── Utilidades ────────────────────────────────────


def error(r: httpx.Response) -> dict:
    return r.json()["error"]


def put_smb(client, headers, password: str | None = SMB_PASSWORD, **changes):
    payload: dict[str, Any] = {"provider": "smb", "settings": {**SMB_SETTINGS, **changes}}
    if password is not None:
        payload["password"] = password
    return client.put(API, headers=headers, json=payload)


def state_from(authorize_url: str) -> str:
    return parse_qs(urlparse(authorize_url).query)["state"][0]


def connect(client, headers, provider: str, code: str = "good-code") -> httpx.Response:
    r = client.post(f"{API}/oauth/{provider}/start", headers=headers)
    assert r.status_code == 200, r.text
    state = state_from(r.json()["authorize_url"])
    return client.get(
        f"{API}/oauth/{provider}/callback",
        params={"code": code, "state": state},
        follow_redirects=False,
    )


def redirect_params(r: httpx.Response) -> dict[str, str]:
    assert r.status_code == 303, r.text
    location = urlparse(r.headers["location"])
    assert f"{location.scheme}://{location.netloc}{location.path}" == (
        "http://testserver/ajustes/documentos"
    )
    return {k: v[0] for k, v in parse_qs(location.query).items()}


def storage_row(tenant_id: UUID) -> TenantStorage:
    with new_session(bypass_rls=True) as db:
        row = service.get_config(db, tenant_id)
        assert row is not None
        return row


def stored_secrets(tenant_id: UUID) -> dict[str, str]:
    row = storage_row(tenant_id)
    return json.loads(decrypt_secret(row.secrets_enc)) if row.secrets_enc else {}


def tenant_db(tenant_id: UUID):
    return new_session(tenant_id=tenant_id)


def doc(tenant_id: UUID, number: str, kind: str = "delivery_note") -> StoredDocument | None:
    with tenant_db(tenant_id) as db:
        return service.find(db, tenant_id, kind, number)


def store(tenant_id: UUID, number: str, data: bytes, kind: str = "delivery_note"):
    with tenant_db(tenant_id) as db:
        result = documents.store(db, tenant_id, kind, number, data, "application/pdf")
        db.commit()
        return result


def fetch(tenant_id: UUID, number: str, regenerate, kind: str = "delivery_note") -> bytes:
    with tenant_db(tenant_id) as db:
        data = documents.fetch(db, tenant_id, kind, number, regenerate)
        db.commit()
        return data


def never() -> bytes:
    raise AssertionError("No debería regenerarse")


def alerts() -> list[Notification]:
    with new_session(bypass_rls=True) as db:
        return list(
            db.exec(select(Notification).where(Notification.type == "documentos_error")).all()
        )


def audits(action: str) -> list[AuditLog]:
    with new_session(bypass_rls=True) as db:
        return list(db.exec(select(AuditLog).where(AuditLog.action == action)).all())


def google_provider(fake_rt: str = GOOGLE_RT, **kwargs) -> GoogleDriveProvider:
    return GoogleDriveProvider("google-id", "google-secret", fake_rt, **kwargs)


# ─── Proveedores ───────────────────────────────────


def test_drive_cuando_guarda_entonces_crea_carpetas_por_ruta_sin_duplicar_y_lee_borra(cloud):
    g = cloud.google
    p = google_provider()
    loc1 = p.save(f"Albaranes/{YEAR}/ALB-1.pdf", b"%PDF-1", "application/pdf")
    loc2 = p.save(f"Albaranes/{YEAR}/ALB-2.pdf", b"%PDF-2", "application/pdf")
    loc3 = p.save(f"Ordenes de carga/{YEAR}/CAR-1.pdf", b"%PDF-3", "application/pdf")
    assert g.files() == {
        f"Konygest/Albaranes/{YEAR}/ALB-1.pdf": b"%PDF-1",
        f"Konygest/Albaranes/{YEAR}/ALB-2.pdf": b"%PDF-2",
        f"Konygest/Ordenes de carga/{YEAR}/CAR-1.pdf": b"%PDF-3",
    }
    folders = [it["name"] for it in g.items.values() if it["mime"] == FOLDER_MIME]
    assert sorted(folders) == sorted(
        ["Konygest", "Albaranes", "Ordenes de carga", str(YEAR), str(YEAR)]
    )
    # El access token se pide una vez por instancia
    assert g.token_calls == 1

    # Otra instancia (otra petición) encuentra las carpetas y sustituye el fichero existente
    p2 = google_provider()
    assert p2.save(f"Albaranes/{YEAR}/ALB-1.pdf", b"%PDF-1b", "application/pdf") == loc1
    assert len([i for i in g.items.values() if i["mime"] == FOLDER_MIME]) == 5
    assert p2.load(loc1) == b"%PDF-1b"
    assert p2.load(loc3) == b"%PDF-3"
    p2.delete(loc2)
    with pytest.raises(DocumentMissingError):
        p2.load(loc2)
    p2.delete(loc2)  # borrar lo que ya no está no falla
    with pytest.raises(StorageProviderError):
        p2.load("../otro")


def test_drive_cuando_token_revocado_o_rotado_entonces_mensaje_o_nuevo_secreto(cloud):
    with pytest.raises(StorageProviderError) as exc:
        google_provider("rt-caducado-xyz").save("a.pdf", b"x", "application/pdf")
    assert "vuelve a conectar" in exc.value.message
    assert "rt-caducado-xyz" not in exc.value.message

    cloud.google.rotate_to = "rt-google-nuevo"
    p = google_provider()
    p.test()
    assert p.rotated_secret == "rt-google-nuevo"
    assert cloud.google.files() == {}  # la prueba borra su fichero

    cloud.google.down = True
    with pytest.raises(StorageProviderError) as exc:
        google_provider().load("g1")
    assert exc.value.message == "No se pudo conectar con Google Drive."


def test_onedrive_cuando_guarda_entonces_ruta_codificada_ubicacion_drive_item_y_rota_token(cloud):
    ms = cloud.ms
    p = OneDriveProvider("ms-id", "ms-secret", "rt-ms-0", root_path="/Konygest")
    loc = p.save(f"Ordenes de carga/{YEAR}/CAR-1.pdf", b"%PDF-c", "application/pdf")
    assert loc == "drv-me/item1"
    assert ms.files() == {f"drv-me:Konygest/Ordenes de carga/{YEAR}/CAR-1.pdf": b"%PDF-c"}
    assert p.load(loc) == b"%PDF-c"
    assert p.rotated_secret == "rt-ms-1"
    p.delete(loc)
    with pytest.raises(DocumentMissingError):
        p.load(loc)
    with pytest.raises(StorageProviderError):
        p.save("grande.pdf", b"x" * (4 * 1024 * 1024 + 1), "application/pdf")

    sp = OneDriveProvider(
        "ms-id", "ms-secret", ms.refresh, site_url="https://norte.sharepoint.com/sites/Oficina"
    )
    assert sp.save("a.pdf", b"%PDF", "application/pdf").startswith("drv-site/")
    assert "Sites.ReadWrite.All" in ms.scopes[-1]


def test_smb_cuando_guarda_entonces_carpetas_lee_borra_y_errores_sin_secretos(nas):
    p = SmbProvider("nas.piensosnorte.es", "documentos", "konygest", SMB_PASSWORD)
    loc = p.save(f"Albaranes/{YEAR}/ALB-1.pdf", b"%PDF-s", "application/pdf")
    assert loc == f"\\\\nas.piensosnorte.es\\documentos\\Konygest\\Albaranes\\{YEAR}\\ALB-1.pdf"
    assert f"\\\\nas.piensosnorte.es\\documentos\\Konygest\\Albaranes\\{YEAR}" in nas.dirs
    assert p.load(loc) == b"%PDF-s"
    p.delete(loc)
    with pytest.raises(DocumentMissingError):
        p.load(loc)
    p.delete(loc)
    # Cada operación cierra su caché de conexiones (no se comparten sesiones entre empresas)
    assert nas.caches_closed >= 4

    # Una ubicación de otro servidor nunca recibe estas credenciales
    nas.logins.clear()
    with pytest.raises(DocumentMissingError):
        p.load("\\\\malicioso\\x\\a.pdf")
    with pytest.raises(StorageProviderError):
        p.load("\\\\nas.piensosnorte.es\\documentos\\..\\a.pdf")
    assert nas.logins == []

    bad = SmbProvider("nas.piensosnorte.es", "documentos", "konygest", "mala-clave")
    with pytest.raises(StorageProviderError) as exc:
        bad.test()
    assert "usuario o la contraseña" in exc.value.message
    assert "mala-clave" not in exc.value.message
    nas.down = True
    with pytest.raises(StorageProviderError) as exc:
        p.test()
    assert exc.value.message == "No se pudo conectar con el servidor nas.piensosnorte.es."
    with pytest.raises(StorageProviderError):
        SmbProvider("nas/otro", "documentos", "u", "p")


# ─── Configuración ─────────────────────────────────


def test_get_cuando_sin_configurar_entonces_platform_y_sin_oauth_no_se_ofrece(
    client, tenant_admin, monkeypatch
):
    _, headers = tenant_admin
    r = client.get(API, headers=headers)
    assert r.status_code == 200
    assert r.json() == {
        "provider": "platform",
        "settings": {},
        "connected_account": None,
        "has_secret": False,
        "status": "not_configured",
        "last_error": None,
        "last_checked_at": None,
        "updated_at": None,
        "updated_by_name": None,
        "available_providers": ["platform", "google_drive", "onedrive", "smb"],
    }
    monkeypatch.setattr(get_settings(), "google_oauth_client_secret", "")
    assert client.get(API, headers=headers).json()["available_providers"] == [
        "platform",
        "onedrive",
        "smb",
    ]
    r = client.post(f"{API}/oauth/google_drive/start", headers=headers)
    assert (r.status_code, error(r)["code"]) == (400, "PROVIDER_NOT_CONFIGURED")
    r = client.put(API, headers=headers, json={"provider": "google_drive", "settings": {}})
    assert (r.status_code, error(r)["code"]) == (400, "PROVIDER_NOT_CONFIGURED")


def test_put_smb_cuando_conecta_entonces_prueba_guarda_y_conserva_contraseña(
    client, tenant_admin, nas
):
    tenant, headers = tenant_admin
    # Contraseña incorrecta: 400 con el motivo y no se guarda nada
    r = put_smb(client, headers, password="mala")
    assert (r.status_code, error(r)["code"]) == (400, "STORAGE_CONNECTION_FAILED")
    assert "contraseña" in error(r)["message"]
    assert client.get(API, headers=headers).json()["provider"] == "platform"
    # Sin contraseña y sin una guardada
    r = put_smb(client, headers, password=None)
    assert (r.status_code, error(r)["field"]) == (400, "password")

    r = put_smb(client, headers)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["provider"] == "smb"
    assert out["settings"] == SMB_SETTINGS
    assert out["has_secret"] is True and out["status"] == "ok"
    assert out["updated_by_name"] == "Admin Piensos Norte"
    assert SMB_PASSWORD not in r.text
    assert SMB_PASSWORD not in client.get(API, headers=headers).text
    assert nas.files == {}  # el fichero de prueba se borra
    assert stored_secrets(tenant.id) == {"smb": SMB_PASSWORD}
    [entry] = audits("documentos.destino")
    assert entry.data["proveedor"] == "smb" and SMB_PASSWORD not in json.dumps(entry.data)

    # Editar sin contraseña: se conserva la guardada (y se prueba con ella)
    nas.logins.clear()
    r = put_smb(client, headers, password=None, root_path="Konygest/Norte")
    assert r.status_code == 200, r.text
    assert r.json()["settings"]["root_path"] == "Konygest/Norte"
    assert nas.logins and set(nas.logins) == {("konygest", SMB_PASSWORD)}
    # Cambiar de servidor exige volver a escribir la contraseña
    r = put_smb(client, headers, password=None, server="10.0.0.5")
    assert (r.status_code, error(r)["field"]) == (400, "password")
    # Datos no válidos
    r = put_smb(client, headers, server="nas\\otro")
    assert r.status_code == 422


def test_put_oauth_cuando_no_conectado_entonces_not_connected(client, tenant_admin):
    _, headers = tenant_admin
    for provider in ("google_drive", "onedrive"):
        r = client.put(API, headers=headers, json={"provider": provider, "settings": {}})
        assert (r.status_code, error(r)["code"]) == (400, "NOT_CONNECTED")


def test_test_cuando_destino_falla_entonces_ok_false_y_estado_error(client, tenant_admin, nas):
    _, headers = tenant_admin
    r = client.post(f"{API}/test", headers=headers)
    assert r.status_code == 200 and r.json()["ok"] is True  # almacenamiento de Konygest
    assert put_smb(client, headers).status_code == 200
    nas.down = True
    r = client.post(f"{API}/test", headers=headers)
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert "No se pudo conectar" in r.json()["message"]
    assert isinstance(r.json()["elapsed_ms"], int)
    out = client.get(API, headers=headers).json()
    assert (out["status"], out["last_error"]) == ("error", r.json()["message"])
    assert out["last_checked_at"] is not None
    nas.down = False
    assert client.post(f"{API}/test", headers=headers).json()["ok"] is True
    assert client.get(API, headers=headers).json()["status"] == "ok"


# ─── OAuth ─────────────────────────────────────────


def test_oauth_google_cuando_start_y_callback_entonces_conecta_y_activa(
    client, tenant_admin, cloud
):
    tenant, headers = tenant_admin
    r = client.post(f"{API}/oauth/google_drive/start", headers=headers)
    url = urlparse(r.json()["authorize_url"])
    params = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert (
        f"{url.scheme}://{url.netloc}{url.path}" == "https://accounts.google.com/o/oauth2/v2/auth"
    )
    assert params["access_type"] == "offline" and params["prompt"] == "consent"
    assert params["scope"] == "https://www.googleapis.com/auth/drive.file openid email"
    assert params["redirect_uri"] == (
        "http://testserver/api/v1/tenant/storage/oauth/google_drive/callback"
    )
    assert params["client_id"] == "google-id"
    claims = jwt.decode(params["state"], options={"verify_signature": False})
    assert claims["type"] == "storage_oauth" and claims["prv"] == "google_drive"
    assert claims["tid"] == str(tenant.id)
    assert claims["exp"] - claims["iat"] == 600

    r = client.get(
        f"{API}/oauth/google_drive/callback",
        params={"code": "good-code", "state": params["state"]},
        follow_redirects=False,
    )
    assert redirect_params(r) == {"connected": "google_drive"}
    out = client.get(API, headers=headers)
    assert out.json()["provider"] == "google_drive"
    assert out.json()["connected_account"] == "oficina@piensosnorte.es"
    assert out.json()["settings"] == {"root_folder_name": "Konygest", "shared_drive_id": None}
    assert out.json()["has_secret"] is True
    assert GOOGLE_RT not in out.text
    assert stored_secrets(tenant.id) == {"google_drive": GOOGLE_RT}
    [entry] = audits("documentos.conectar")
    assert entry.data["proveedor"] == "google_drive" and GOOGLE_RT not in json.dumps(entry.data)

    # Ya conectada: el PUT prueba y guarda los ajustes
    r = client.put(
        API,
        headers=headers,
        json={
            "provider": "google_drive",
            "settings": {"root_folder_name": "Docs", "shared_drive_id": ""},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["settings"] == {"root_folder_name": "Docs", "shared_drive_id": None}

    # Los documentos nuevos van a Drive
    store(tenant.id, f"ALB-{YEAR}-0001", b"%PDF-drive")
    assert cloud.google.files() == {f"Docs/Albaranes/{YEAR}/ALB-{YEAR}-0001.pdf": b"%PDF-drive"}
    assert doc(tenant.id, f"ALB-{YEAR}-0001").provider == "google_drive"


def test_oauth_microsoft_cuando_callback_entonces_cuenta_y_token_rotado_guardado(
    client, tenant_admin, cloud
):
    tenant, headers = tenant_admin
    r = client.post(f"{API}/oauth/onedrive/start", headers=headers)
    params = {k: v[0] for k, v in parse_qs(urlparse(r.json()["authorize_url"]).query).items()}
    assert params["scope"] == "offline_access User.Read Files.ReadWrite"
    assert urlparse(r.json()["authorize_url"]).path == "/common/oauth2/v2.0/authorize"
    r = client.get(
        f"{API}/oauth/onedrive/callback",
        params={"code": "good-code", "state": params["state"]},
        follow_redirects=False,
    )
    assert redirect_params(r) == {"connected": "onedrive"}
    out = client.get(API, headers=headers).json()
    assert (out["provider"], out["connected_account"]) == ("onedrive", "ana@norte.com")
    assert out["settings"] == {"root_path": "/Konygest", "site_url": None}
    assert stored_secrets(tenant.id) == {"onedrive": "rt-ms-1"}

    store(tenant.id, f"ALB-{YEAR}-0001", b"%PDF-od")
    assert cloud.ms.files() == {f"drv-me:Konygest/Albaranes/{YEAR}/ALB-{YEAR}-0001.pdf": b"%PDF-od"}
    # Microsoft ha rotado el refresh token al usarlo: se guarda el nuevo
    assert stored_secrets(tenant.id) == {"onedrive": "rt-ms-2"}
    assert fetch(tenant.id, f"ALB-{YEAR}-0001", never) == b"%PDF-od"
    assert stored_secrets(tenant.id) == {"onedrive": "rt-ms-3"}

    # Con SharePoint se pide el permiso de sitios
    r = client.post(f"{API}/oauth/onedrive/start", headers=headers, params={"sharepoint": "true"})
    assert "Sites.ReadWrite.All" in parse_qs(urlparse(r.json()["authorize_url"]).query)["scope"][0]


def test_oauth_callback_cuando_state_caducado_manipulado_o_error_entonces_redirige_con_codigo(
    client, tenant_admin
):
    tenant, headers = tenant_admin
    user_id = jwt.decode(headers["Authorization"][7:], options={"verify_signature": False})["sub"]
    url = f"{API}/oauth/google_drive/callback"
    secret = get_settings().jwt_secret_key

    def call(**params):
        return redirect_params(client.get(url, params=params, follow_redirects=False))

    expired = jwt.encode(
        {
            "type": "storage_oauth",
            "tid": str(tenant.id),
            "sub": user_id,
            "prv": "google_drive",
            "exp": utcnow() - timedelta(minutes=1),
        },
        secret,
        algorithm="HS256",
    )
    assert call(code="good-code", state=expired) == {"error": "INVALID_STATE"}

    good = state_from(
        client.post(f"{API}/oauth/google_drive/start", headers=headers).json()["authorize_url"]
    )
    head, payload, sig = good.split(".")
    tampered = f"{head}.{payload}.{sig[:-2]}{'AA' if sig[-2:] != 'AA' else 'BB'}"
    assert call(code="good-code", state=tampered) == {"error": "INVALID_STATE"}
    # Un token de acceso no sirve como state, ni el state de otro proveedor
    access = create_access_token(UUID(user_id), tenant.id)
    assert call(code="good-code", state=access) == {"error": "INVALID_STATE"}
    other = oauth.create_state(tenant.id, UUID(user_id), "onedrive")
    assert call(code="good-code", state=other) == {"error": "INVALID_STATE"}
    assert call(code="good-code") == {"error": "INVALID_STATE"}
    # El usuario cancela en Google, o el código no vale
    assert call(error="access_denied", state=good) == {"error": "access_denied"}
    assert call(code="bad-code", state=good) == {"error": "OAUTH_FAILED"}
    assert service_row_missing(tenant.id)

    assert call(code="good-code", state=good) == {"connected": "google_drive"}


def service_row_missing(tenant_id: UUID) -> bool:
    with new_session(bypass_rls=True) as db:
        return service.get_config(db, tenant_id) is None


# ─── store / fetch ─────────────────────────────────


def test_store_cuando_destino_caido_entonces_plataforma_y_un_solo_aviso_al_dia(
    client, tenant_admin, nas, platform
):
    tenant, headers = tenant_admin
    assert put_smb(client, headers).status_code == 200
    nas.down = True
    first = store(tenant.id, f"ALB-{YEAR}-0001", b"%PDF-1")
    store(tenant.id, f"ALB-{YEAR}-0002", b"%PDF-2")
    assert first.provider == "platform"
    assert platform.files == {
        f"{tenant.id}/Albaranes/{YEAR}/ALB-{YEAR}-0001.pdf": b"%PDF-1",
        f"{tenant.id}/Albaranes/{YEAR}/ALB-{YEAR}-0002.pdf": b"%PDF-2",
    }
    [alert] = alerts()
    assert alert.link == "/ajustes/documentos"
    assert SMB_PASSWORD not in alert.body
    out = client.get(API, headers=headers).json()
    assert out["status"] == "error" and "No se pudo conectar" in out["last_error"]

    # Pasado un día, otro aviso
    with new_session(bypass_rls=True) as db:
        row = service.get_config(db, tenant.id)
        row.last_alert_at = utcnow() - timedelta(days=1, minutes=1)
        db.add(row)
        db.commit()
    store(tenant.id, f"ALB-{YEAR}-0003", b"%PDF-3")
    assert len(alerts()) == 2

    # Vuelve el NAS: el siguiente va allí y el estado vuelve a ok; los anteriores se leen
    # de Konygest, donde quedaron
    nas.down = False
    assert store(tenant.id, f"ALB-{YEAR}-0004", b"%PDF-4").provider == "smb"
    assert client.get(API, headers=headers).json()["status"] == "ok"
    assert fetch(tenant.id, f"ALB-{YEAR}-0001", never) == b"%PDF-1"


def test_fetch_cuando_fichero_borrado_o_sin_registro_entonces_regenera_y_guarda(
    client, tenant_admin, nas
):
    tenant, headers = tenant_admin
    assert put_smb(client, headers).status_code == 200
    number = f"ALB-{YEAR}-0001"
    stored = store(tenant.id, number, b"%PDF-v1")
    assert stored.size == 7 and len(stored.sha256) == 64
    assert fetch(tenant.id, number, never) == b"%PDF-v1"

    nas.files.clear()  # alguien lo borra a mano
    assert fetch(tenant.id, number, lambda: b"%PDF-v2") == b"%PDF-v2"
    assert list(nas.files.values()) == [b"%PDF-v2"]
    assert fetch(tenant.id, number, never) == b"%PDF-v2"
    # Sin registro previo: se genera y queda registrado
    assert fetch(tenant.id, "CAR-1", lambda: b"%PDF-c", kind="loading_order") == b"%PDF-c"
    assert doc(tenant.id, "CAR-1", "loading_order").location.endswith(
        f"\\Ordenes de carga\\{YEAR}\\CAR-1.pdf"
    )
    # Un número con barras nunca sale de su carpeta
    with pytest.raises(ValueError):
        store(tenant.id, "../x", b"x")


def test_cambio_de_destino_cuando_documentos_antiguos_entonces_se_leen_de_su_proveedor(
    client, tenant_admin, nas, cloud, platform
):
    tenant, headers = tenant_admin
    store(tenant.id, "ALB-P", b"%PDF-plataforma")
    assert put_smb(client, headers).status_code == 200
    store(tenant.id, "ALB-S", b"%PDF-nas")
    assert redirect_params(connect(client, headers, "google_drive")) == {
        "connected": "google_drive"
    }
    store(tenant.id, "ALB-G", b"%PDF-drive")
    assert [doc(tenant.id, n).provider for n in ("ALB-P", "ALB-S", "ALB-G")] == [
        "platform",
        "smb",
        "google_drive",
    ]
    for number, data in (
        ("ALB-P", b"%PDF-plataforma"),
        ("ALB-S", b"%PDF-nas"),
        ("ALB-G", b"%PDF-drive"),
    ):
        assert fetch(tenant.id, number, never) == data

    # Volver a Konygest borra las credenciales: lo de Drive y el NAS ya no se puede leer de
    # allí y se regenera en el almacenamiento de Konygest
    r = client.delete(API, headers=headers)
    assert r.status_code == 200 and r.json()["provider"] == "platform"
    assert storage_row(tenant.id).secrets_enc is None
    assert len(audits("documentos.desconectar")) == 1
    nas.logins.clear()
    assert fetch(tenant.id, "ALB-S", lambda: b"%PDF-nas-2") == b"%PDF-nas-2"
    assert nas.logins == []
    assert doc(tenant.id, "ALB-S").provider == "platform"
    assert fetch(tenant.id, "ALB-P", never) == b"%PDF-plataforma"


# ─── Permisos y aislamiento ────────────────────────


def test_permisos_cuando_sin_empresa_configurar_entonces_403(client, tenant_admin):
    _, headers = tenant_admin
    other = invite_user(client, headers, "oficina@piensosnorte.es", ["Oficina"])
    for method, path in (
        ("GET", API),
        ("PUT", API),
        ("DELETE", API),
        ("POST", f"{API}/test"),
        ("POST", f"{API}/oauth/google_drive/start"),
        ("GET", f"{API}/documents"),
    ):
        kwargs = {"json": {"provider": "platform"}} if method == "PUT" else {}
        r = client.request(method, path, headers=other, **kwargs)
        assert r.status_code == 403, (method, path, r.text)
    assert client.get(API).status_code == 401


def test_aislamiento_cuando_otra_empresa_entonces_no_ve_ni_lee_sus_documentos(
    client, make_tenant, nas, platform
):
    from tests.conftest import auth

    a, a_email = make_tenant("Piensos Norte")
    b, b_email = make_tenant("Piensos Sur")
    ha, hb = auth(client, a_email), auth(client, b_email)
    assert put_smb(client, ha).status_code == 200
    store(a.id, f"ALB-{YEAR}-0001", b"%PDF-a")
    store(a.id, "CAR-9", b"%PDF-c", kind="loading_order")

    r = client.get(f"{API}/documents", headers=ha, params={"kind": "delivery_note"})
    assert r.status_code == 200
    page = r.json()
    assert page["total"] == 1
    item = page["items"][0]
    assert set(item) == {
        "id",
        "kind",
        "number",
        "filename",
        "provider",
        "size",
        "created_at",
        "source_type",
        "source_id",
    }
    assert (item["number"], item["provider"], item["filename"]) == (
        f"ALB-{YEAR}-0001",
        "smb",
        f"ALB-{YEAR}-0001.pdf",
    )
    assert client.get(f"{API}/documents", headers=ha, params={"search": "car"}).json()["total"] == 1
    assert client.get(f"{API}/documents", headers=ha, params={"search": "%"}).json()["total"] == 0

    # La empresa B no ve la configuración ni los documentos de A
    assert client.get(API, headers=hb).json()["provider"] == "platform"
    assert client.get(f"{API}/documents", headers=hb).json()["total"] == 0
    with tenant_db(b.id) as db:
        assert service.find(db, a.id, "delivery_note", f"ALB-{YEAR}-0001") is None
        assert db.exec(select(TenantStorage)).all() == []
    # Ni con una clave de A en su propio almacenamiento
    store(a.id, "ALB-PLAT", b"%PDF")  # (va al NAS de A)
    key = f"{a.id}/Albaranes/{YEAR}/X.pdf"
    platform.files[key] = b"%PDF-a"
    from app.modules.documents.providers.platform import PlatformProvider

    with pytest.raises(StorageProviderError):
        PlatformProvider(b.id).load(key)
    # B regenera su propio número sin tocar el de A
    assert fetch(b.id, f"ALB-{YEAR}-0001", lambda: b"%PDF-b") == b"%PDF-b"
    assert fetch(a.id, f"ALB-{YEAR}-0001", never) == b"%PDF-a"


# ─── Logística ─────────────────────────────────────


def test_albaran_logistica_cuando_destino_smb_entonces_store_y_fetch_regenera(
    client,
    ctx,  # noqa: F811
    nas,
    monkeypatch,
):
    monkeypatch.setattr(documents, "render_delivery_note", lambda data: b"%PDF-albaran")
    monkeypatch.setattr(documents, "render_loading_order", lambda data: b"%PDF-orden")
    assert put_smb(client, ctx.admin).status_code == 200

    order = make_order(ctx, "c1", [("ceb", 12000)])
    load = create(client, ctx, body(ctx, [order]))
    ready = act(client, ctx.ofi, load, "release")
    loaded = act(client, ctx.fab, load, "load", weigh_body(ready, silos(ctx)))
    stop = loaded["stops"][0]
    number = stop["delivery_note_number"]
    assert stop["delivery_note_ready"] is True
    path = f"\\\\nas.piensosnorte.es\\documentos\\Konygest\\Albaranes\\{YEAR}\\{number}.pdf"
    assert nas.files == {path: b"%PDF-albaran"}
    saved = doc(ctx.tenant_id, number)
    assert (saved.provider, saved.source_type, str(saved.source_id)) == (
        "smb",
        "load_stop",
        stop["id"],
    )

    url = f"/api/v1/loads/{load['id']}/stops/{stop['id']}/delivery-note.pdf"
    r = client.get(url, headers=ctx.ofi)
    assert (r.status_code, r.content) == (200, b"%PDF-albaran")
    # Borrado en el NAS: se regenera con los datos de la carga y se vuelve a guardar
    nas.files.clear()
    monkeypatch.setattr(documents, "render_delivery_note", lambda data: b"%PDF-regenerado")
    r = client.get(url, headers=ctx.ofi)
    assert (r.status_code, r.content) == (200, b"%PDF-regenerado")
    assert nas.files == {path: b"%PDF-regenerado"}
