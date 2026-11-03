from app.modules.platform import email
from tests.conftest import auth, invite_user, last_email_token, login

ADMIN = "/api/v1/admin"


def test_panel_cuando_usuario_de_empresa_entonces_403(client, tenant_admin):
    _, headers = tenant_admin
    assert client.get(f"{ADMIN}/tenants", headers=headers).status_code == 403


def test_panel_cuando_klyp_sin_2fa_entonces_exige_activarlo(client):
    from app.core.db import new_session
    from app.core.security import hash_password
    from app.modules.users.models import PlatformRole, User

    with new_session(bypass_rls=True) as db:
        db.add(
            User(
                email="soporte@klyp.es",
                full_name="S",
                password_hash=hash_password("p" * 12),
                platform_role=PlatformRole.SUPPORT,
            )
        )
        db.commit()
    headers = auth(client, "soporte@klyp.es", "p" * 12)
    r = client.get(f"{ADMIN}/tenants", headers=headers)
    assert r.json()["error"]["code"] == "TWO_FACTOR_SETUP_REQUIRED"


def test_panel_cuando_alta_de_empresa_entonces_invita_al_admin_y_aparece_en_listado(
    client, platform_admin
):
    r = client.post(
        f"{ADMIN}/tenants",
        headers=platform_admin,
        json={"name": "Piensos Este", "admin_email": "jefe@este.es", "admin_name": "Jefe"},
    )
    assert r.status_code == 201
    assert r.json()["status"] == "trial"
    assert last_email_token("jefe@este.es")
    page = client.get(f"{ADMIN}/tenants", headers=platform_admin, params={"search": "este"}).json()
    assert page["total"] == 1
    assert page["items"][0]["users"] == 1
    stats = client.get(f"{ADMIN}/stats", headers=platform_admin).json()
    assert stats["tenants"]["trial"] == 1


def test_panel_cuando_desactiva_empresa_entonces_sus_usuarios_no_entran(
    client, platform_admin, make_tenant
):
    tenant, admin_email = make_tenant()
    headers = auth(client, admin_email)
    r = client.patch(
        f"{ADMIN}/tenants/{tenant.id}", headers=platform_admin, json={"status": "disabled"}
    )
    assert r.json()["status"] == "disabled"
    assert client.get("/api/v1/me", headers=headers).json()["error"]["code"] == "TENANT_DISABLED"
    assert login(client, admin_email).json()["error"]["code"] == "TENANT_DISABLED"

    client.patch(f"{ADMIN}/tenants/{tenant.id}", headers=platform_admin, json={"status": "active"})
    assert login(client, admin_email).status_code == 200


def test_panel_cuando_modulo_disponible_entonces_empresa_puede_activarlo(
    client, platform_admin, tenant_admin
):
    tenant, headers = tenant_admin
    r = client.put(
        f"{ADMIN}/tenants/{tenant.id}/modules/crm",
        headers=platform_admin,
        json={"available": True},
    )
    assert r.status_code == 200
    r = client.put("/api/v1/tenant/modules/crm", headers=headers, json={"enabled": True})
    assert r.status_code == 200
    assert "crm" in client.get("/api/v1/me", headers=headers).json()["modules"]
    perms = {p["code"]: p for p in client.get("/api/v1/permissions", headers=headers).json()}
    assert perms["crm.ver"]["available"] is True

    # Si Klyp lo quita del plan, se apaga y sus permisos dejan de contar
    client.put(
        f"{ADMIN}/tenants/{tenant.id}/modules/crm",
        headers=platform_admin,
        json={"available": False},
    )
    me = client.get("/api/v1/me", headers=headers).json()
    assert "crm" not in me["modules"]
    assert "crm.ver" not in me["permissions"]


def test_panel_cuando_modo_soporte_entonces_actua_en_la_empresa_y_queda_auditado(
    client, platform_admin, tenant_admin
):
    tenant, headers = tenant_admin
    token = client.post(f"{ADMIN}/tenants/{tenant.id}/support", headers=platform_admin).json()
    support = {"Authorization": f"Bearer {token['access_token']}"}
    me = client.get("/api/v1/me", headers=support).json()
    assert me["support_mode"] is True
    assert me["tenant"]["id"] == str(tenant.id)
    assert client.get("/api/v1/users", headers=support).status_code == 200
    actions = [a["action"] for a in client.get("/api/v1/audit", headers=headers).json()["items"]]
    assert "admin.modo_soporte" in actions


def test_panel_cuando_guarda_smtp_entonces_no_devuelve_password_y_envia_prueba(
    client, platform_admin
):
    body = {
        "host": "smtp.klyp.es",
        "port": 587,
        "username": "u",
        "password": "secreta",
        "use_tls": True,
        "from_email": "no-reply@klyp.es",
        "from_name": "Konygest",
    }
    r = client.put(f"{ADMIN}/email-config", headers=platform_admin, json=body)
    assert r.json()["has_password"] is True
    assert "password" not in r.json()
    email.outbox.clear()
    r = client.post(f"{ADMIN}/email-config/test", headers=platform_admin, json={"to": "a@b.es"})
    assert r.status_code == 204
    assert email.outbox[-1]["From"] == "Konygest <no-reply@klyp.es>"


def test_email_cuando_empresa_tiene_smtp_propio_entonces_lo_usa(client, tenant_admin):
    _, headers = tenant_admin
    client.put(
        "/api/v1/tenant/email-config",
        headers=headers,
        json={
            "host": "smtp.norte.es",
            "port": 587,
            "from_email": "avisos@norte.es",
            "from_name": "Piensos Norte",
        },
    )
    invite_user(client, headers, "c@x.es", ["Comercial"])
    sent = [m for m in email.outbox if m["To"] == "c@x.es"]
    assert sent[-1]["From"] == "Piensos Norte <avisos@norte.es>"


def test_avisos_cuando_se_invita_usuario_entonces_otros_admins_reciben_aviso(client, tenant_admin):
    _, headers = tenant_admin
    other_admin = invite_user(client, headers, "admin2@x.es", ["Administrador"])
    invite_user(client, headers, "c@x.es", ["Comercial"])
    assert (
        client.get("/api/v1/notifications/unread-count", headers=other_admin).json()["unread"] == 1
    )
    page = client.get("/api/v1/notifications", headers=other_admin).json()
    notification = page["items"][0]
    assert notification["type"] == "usuario_alta"
    client.post(f"/api/v1/notifications/{notification['id']}/read", headers=other_admin)
    assert (
        client.get("/api/v1/notifications/unread-count", headers=other_admin).json()["unread"] == 0
    )


def test_avisos_cuando_empresa_quita_canal_entonces_usuario_no_lo_recibe(client, tenant_admin):
    _, headers = tenant_admin
    other_admin = invite_user(client, headers, "admin2@x.es", ["Administrador"])
    client.put(
        "/api/v1/notifications/tenant-settings",
        headers=headers,
        json=[{"type": "usuario_alta", "in_app": False, "email": False, "push": False}],
    )
    prefs = {
        p["type"]: p
        for p in client.get("/api/v1/notifications/preferences", headers=other_admin).json()
    }
    assert prefs["usuario_alta"]["in_app"] is False
    invite_user(client, headers, "c@x.es", ["Comercial"])
    assert (
        client.get("/api/v1/notifications/unread-count", headers=other_admin).json()["unread"] == 0
    )


def test_avisos_cuando_usuario_activa_email_y_empresa_lo_permite_entonces_le_llega(
    client, tenant_admin
):
    _, headers = tenant_admin
    other_admin = invite_user(client, headers, "admin2@x.es", ["Administrador"])
    client.put(
        "/api/v1/notifications/tenant-settings",
        headers=headers,
        json=[{"type": "usuario_alta", "in_app": True, "email": True, "push": False}],
    )
    email.outbox.clear()
    invite_user(client, headers, "c@x.es", ["Comercial"])
    assert any(m["To"] == "admin2@x.es" for m in email.outbox)

    client.put(
        "/api/v1/notifications/preferences",
        headers=other_admin,
        json=[{"type": "usuario_alta", "in_app": True, "email": False, "push": False}],
    )
    email.outbox.clear()
    invite_user(client, headers, "d@x.es", ["Comercial"])
    assert not any(m["To"] == "admin2@x.es" for m in email.outbox)
