import pyotp

from tests.conftest import (
    PASSWORD,
    auth,
    enable_totp,
    get_user,
    invite_user,
    last_email_token,
    login,
)


def test_login_cuando_credenciales_correctas_entonces_devuelve_token_y_permisos(
    client, make_tenant
):
    _, admin_email = make_tenant()
    r = login(client, admin_email)
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["email"] == admin_email
    assert body["user"]["permissions"]["roles.gestionar"] == "all"
    assert "kg_refresh" in r.cookies


def test_login_cuando_password_incorrecta_entonces_401_sin_revelar_motivo(client, make_tenant):
    _, admin_email = make_tenant()
    r = login(client, admin_email, "otra-contraseña")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "INVALID_CREDENTIALS"
    r = login(client, "noexiste@x.es", "otra-contraseña")
    assert r.json()["error"]["code"] == "INVALID_CREDENTIALS"


def test_login_cuando_5_fallos_entonces_cuenta_bloqueada(client, make_tenant):
    _, admin_email = make_tenant()
    for _ in range(5):
        login(client, admin_email, "mala-contraseña")
    r = login(client, admin_email)
    assert r.status_code == 423
    assert r.json()["error"]["code"] == "ACCOUNT_LOCKED"


def test_login_cuando_muchos_intentos_desde_misma_ip_entonces_429(client):
    codes = [login(client, f"u{i}@x.es", "x").status_code for i in range(11)]
    assert codes[-1] == 429


def test_refresh_cuando_cookie_valida_entonces_rota_y_reuso_cierra_sesiones(client, make_tenant):
    _, admin_email = make_tenant()
    first = login(client, admin_email).cookies["kg_refresh"]
    client.cookies.set("kg_refresh", first, path="/api/v1/auth")
    r = client.post("/api/v1/auth/refresh")
    assert r.status_code == 200
    second = r.cookies["kg_refresh"]
    assert second != first

    # Reusar el refresh ya rotado se trata como robo: se cierran todas las sesiones
    client.cookies.clear()
    client.cookies.set("kg_refresh", first, path="/api/v1/auth")
    assert client.post("/api/v1/auth/refresh").status_code == 401
    client.cookies.clear()
    client.cookies.set("kg_refresh", second, path="/api/v1/auth")
    assert client.post("/api/v1/auth/refresh").status_code == 401


def test_logout_cuando_cierra_sesion_entonces_refresh_deja_de_valer(client, make_tenant):
    _, admin_email = make_tenant()
    token = login(client, admin_email).cookies["kg_refresh"]
    client.cookies.set("kg_refresh", token, path="/api/v1/auth")
    assert client.post("/api/v1/auth/logout").status_code == 204
    client.cookies.set("kg_refresh", token, path="/api/v1/auth")
    assert client.post("/api/v1/auth/refresh").status_code == 401


def test_recuperar_password_cuando_enlace_valido_entonces_cambia_y_enlace_no_reutilizable(
    client, make_tenant
):
    _, admin_email = make_tenant()
    assert (
        client.post("/api/v1/auth/forgot-password", json={"email": admin_email}).status_code == 204
    )
    token = last_email_token(admin_email)
    body = {"token": token, "password": "nueva-contraseña-1"}
    assert client.post("/api/v1/auth/reset-password", json=body).status_code == 204
    assert login(client, admin_email, "nueva-contraseña-1").status_code == 200
    r = client.post("/api/v1/auth/reset-password", json=body)
    assert r.json()["error"]["code"] == "INVALID_TOKEN"


def test_recuperar_password_cuando_email_no_existe_entonces_204_igualmente(client):
    r = client.post("/api/v1/auth/forgot-password", json={"email": "nadie@x.es"})
    assert r.status_code == 204


def test_invitacion_cuando_password_corta_entonces_weak_password(client, tenant_admin):
    _, headers = tenant_admin
    roles = client.get("/api/v1/roles", headers=headers).json()
    client.post(
        "/api/v1/users",
        headers=headers,
        json={"email": "nuevo@x.es", "full_name": "Nuevo", "role_ids": [roles[0]["id"]]},
    )
    token = last_email_token("nuevo@x.es")
    info = client.get("/api/v1/auth/invitation", params={"token": token}).json()
    assert info["email"] == "nuevo@x.es"
    r = client.post("/api/v1/auth/accept-invite", json={"token": token, "password": "corta"})
    assert r.json()["error"]["code"] == "WEAK_PASSWORD"


def test_2fa_cuando_activado_entonces_login_pide_codigo(client, make_tenant):
    _, admin_email = make_tenant()
    secret = enable_totp(client, auth(client, admin_email))
    r = login(client, admin_email)
    assert r.json()["error"]["code"] == "TOTP_REQUIRED"
    r = login(client, admin_email, code="000000")
    assert r.json()["error"]["code"] == "TOTP_INVALID"
    assert login(client, admin_email, code=pyotp.TOTP(secret).now()).status_code == 200


def test_2fa_cuando_empresa_lo_exige_entonces_bloquea_hasta_activarlo(client, tenant_admin):
    _, headers = tenant_admin
    client.patch("/api/v1/tenant", headers=headers, json={"require_2fa": True})
    r = client.get("/api/v1/users", headers=headers)
    assert r.json()["error"]["code"] == "TWO_FACTOR_SETUP_REQUIRED"
    assert client.get("/api/v1/me", headers=headers).json()["must_setup_2fa"] is True
    enable_totp(client, headers)
    assert client.get("/api/v1/users", headers=headers).status_code == 200


def test_usuario_desactivado_cuando_usa_token_entonces_401(client, tenant_admin):
    _, headers = tenant_admin
    user_headers = invite_user(client, headers, "comercial@x.es", ["Comercial"])
    user_id = get_user("comercial@x.es").id
    client.patch(f"/api/v1/users/{user_id}", headers=headers, json={"is_active": False})
    assert client.get("/api/v1/me", headers=user_headers).status_code == 401
    assert login(client, "comercial@x.es", PASSWORD).status_code == 401


def test_cambiar_password_cuando_actual_incorrecta_entonces_error(client, tenant_admin):
    _, headers = tenant_admin
    r = client.post(
        "/api/v1/me/password",
        headers=headers,
        json={"current_password": "mala", "new_password": "otra-larga-123"},
    )
    assert r.json()["error"]["field"] == "current_password"
