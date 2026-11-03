"""Tests contra PostgreSQL real (base de datos `<db>_test`), para que la Row Level
Security se ejecute igual que en producción.

Las URLs salen de TEST_DATABASE_URL / TEST_DATABASE_APP_URL o, si no están, del
.env de la raíz cambiando el nombre de la base de datos por `<db>_test`.
"""

import os
import re
from collections.abc import Callable, Iterator
from pathlib import Path


def _load_dotenv() -> dict[str, str]:
    path = Path(__file__).resolve().parents[2] / ".env"
    if not path.exists():
        return {}
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^([A-Z0-9_]+)=([^#]*)", line.strip())
        if match:
            values[match.group(1)] = match.group(2).strip()
    return values


def _test_url(url: str) -> str:
    base, name = url.rsplit("/", 1)
    return f"{base}/{name}_test"


_env = _load_dotenv()
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL") or _test_url(_env["DATABASE_URL"])
os.environ["DATABASE_APP_URL"] = os.environ.get("TEST_DATABASE_APP_URL") or _test_url(
    _env["DATABASE_APP_URL"]
)
os.environ.setdefault("JWT_SECRET_KEY", _env.get("JWT_SECRET_KEY") or "test-" + "x" * 40)
os.environ.setdefault(
    "ENCRYPTION_KEY", _env.get("ENCRYPTION_KEY") or "q2Kc2k3w5n0VZp8n3q9C4m9Xx4o6Jm0p0Y3cX2u7b1E="
)
os.environ["EMAIL_BACKEND"] = "memory"
os.environ["REDIS_URL"] = ""
os.environ["APP_ENV"] = "test"
os.environ["APP_URL"] = "http://testserver"

import pyotp  # noqa: E402
import pytest  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402
from sqlmodel import select  # noqa: E402

from alembic import command  # noqa: E402
from app.core import ratelimit  # noqa: E402
from app.core.db import new_session  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.main import app  # noqa: E402
from app.modules.platform import email  # noqa: E402
from app.modules.tenants.models import Tenant, TenantStatus  # noqa: E402
from app.modules.tenants.service import create_tenant  # noqa: E402
from app.modules.users.models import PlatformRole, User  # noqa: E402

PASSWORD = "contraseña-segura-1"
BACKEND_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session", autouse=True)
def _database() -> Iterator[None]:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    config.attributes["url"] = os.environ["DATABASE_URL"]
    command.downgrade(config, "base")
    command.upgrade(config, "head")
    yield


@pytest.fixture(autouse=True)
def _clean() -> Iterator[None]:
    owner = create_engine(os.environ["DATABASE_URL"])
    with owner.begin() as conn:
        tables = (
            conn.execute(
                text(
                    "SELECT tablename FROM pg_tables WHERE schemaname='public' "
                    "AND tablename <> 'alembic_version'"
                )
            )
            .scalars()
            .all()
        )
        conn.execute(text(f"TRUNCATE {', '.join(tables)} CASCADE"))
    owner.dispose()
    email.outbox.clear()
    assert isinstance(ratelimit.counter, ratelimit._MemoryCounter)
    ratelimit.counter.clear()
    yield


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def last_email_token(to: str) -> str:
    """Saca el token del enlace del último email enviado a `to`."""
    for msg in reversed(email.outbox):
        if msg["To"] == to:
            html = msg.get_body(("html",)).get_content()  # type: ignore[union-attr]
            match = re.search(r"token=([A-Za-z0-9_\-]+)", html)
            assert match, "El email no tiene enlace con token"
            return match.group(1)
    raise AssertionError(f"No hay emails para {to}")


def login(client: TestClient, email_: str, password: str = PASSWORD, code: str | None = None):
    body = {"email": email_, "password": password}
    if code:
        body["totp_code"] = code
    return client.post("/api/v1/auth/login", json=body)


def auth(client: TestClient, email_: str, password: str = PASSWORD) -> dict[str, str]:
    response = login(client, email_, password)
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture
def make_tenant(client: TestClient) -> Callable[..., tuple[Tenant, str]]:
    """Crea una empresa e invita a su admin, que acepta. Devuelve (empresa, email admin)."""

    def factory(name: str = "Piensos Norte", status: TenantStatus = TenantStatus.ACTIVE):
        admin_email = f"admin@{name.lower().replace(' ', '')}.es"
        with new_session(bypass_rls=True) as db:
            tenant = create_tenant(db, name, None, admin_email, f"Admin {name}", status)
            db.commit()
        token = last_email_token(admin_email)
        r = client.post("/api/v1/auth/accept-invite", json={"token": token, "password": PASSWORD})
        assert r.status_code == 204, r.text
        return tenant, admin_email

    return factory


@pytest.fixture
def tenant_admin(make_tenant, client) -> tuple[Tenant, dict[str, str]]:
    tenant, admin_email = make_tenant()
    return tenant, auth(client, admin_email)


def invite_user(
    client: TestClient, headers: dict[str, str], email_: str, role_names: list[str]
) -> dict[str, str]:
    """Invita a un usuario con los roles indicados, acepta y devuelve sus cabeceras."""
    roles = {r["name"]: r["id"] for r in client.get("/api/v1/roles", headers=headers).json()}
    r = client.post(
        "/api/v1/users",
        headers=headers,
        json={
            "email": email_,
            "full_name": email_.split("@")[0],
            "role_ids": [roles[n] for n in role_names],
        },
    )
    assert r.status_code == 201, r.text
    r = client.post(
        "/api/v1/auth/accept-invite",
        json={"token": last_email_token(email_), "password": PASSWORD},
    )
    assert r.status_code == 204, r.text
    return auth(client, email_)


def enable_totp(client: TestClient, headers: dict[str, str]) -> str:
    secret = client.post("/api/v1/auth/2fa/setup", headers=headers).json()["secret"]
    r = client.post(
        "/api/v1/auth/2fa/enable", headers=headers, json={"code": pyotp.TOTP(secret).now()}
    )
    assert r.status_code == 204, r.text
    return secret


@pytest.fixture
def platform_admin(client) -> dict[str, str]:
    """Superadmin de Klyp con 2FA activo."""
    email_ = "admin@klyp.es"
    with new_session(bypass_rls=True) as db:
        db.add(
            User(
                email=email_,
                full_name="Klyp",
                password_hash=hash_password(PASSWORD),
                platform_role=PlatformRole.SUPERADMIN,
            )
        )
        db.commit()
    headers = auth(client, email_)
    secret = enable_totp(client, headers)
    r = login(client, email_, code=pyotp.TOTP(secret).now())
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def get_user(email_: str) -> User:
    with new_session(bypass_rls=True) as db:
        return db.exec(select(User).where(User.email == email_)).one()
