from sqlmodel import select

from app.core.db import new_session
from app.modules.tenants.models import TenantStatus
from app.modules.users.models import Role, User
from tests.conftest import auth, get_user, invite_user


def test_aislamiento_cuando_dos_empresas_entonces_cada_una_solo_ve_lo_suyo(client, make_tenant):
    tenant_a, email_a = make_tenant("Piensos Norte")
    tenant_b, email_b = make_tenant("Piensos Sur")
    headers_a = auth(client, email_a)

    emails = [u["email"] for u in client.get("/api/v1/users", headers=headers_a).json()["items"]]
    assert emails == [email_a]

    role_b = client.get("/api/v1/roles", headers=auth(client, email_b)).json()[0]
    r = client.patch(f"/api/v1/roles/{role_b['id']}", headers=headers_a, json={"name": "X"})
    assert r.status_code == 404


def test_rls_cuando_sesion_de_empresa_entonces_bd_no_devuelve_filas_ajenas(make_tenant):
    tenant_a, _ = make_tenant("Piensos Norte")
    tenant_b, _ = make_tenant("Piensos Sur")
    with new_session(tenant_id=tenant_a.id) as db:
        tenants = {r.tenant_id for r in db.exec(select(Role)).all()}
        users = {u.tenant_id for u in db.exec(select(User)).all()}
    assert tenants == {tenant_a.id}
    assert users == {tenant_a.id}
    with new_session() as db:  # sin empresa ni bypass: nada
        assert db.exec(select(Role)).all() == []


def test_empresa_nueva_cuando_se_crea_entonces_tiene_roles_de_plantilla(client, tenant_admin):
    _, headers = tenant_admin
    names = {r["name"] for r in client.get("/api/v1/roles", headers=headers).json()}
    assert names == {"Administrador", "Dirección", "Oficina", "Fábrica", "Comercial"}


def test_rol_personalizado_cuando_falta_permiso_entonces_403(client, tenant_admin):
    _, headers = tenant_admin
    r = client.post(
        "/api/v1/roles",
        headers=headers,
        json={"name": "Báscula", "permissions": {"cargas.pesar": "all"}},
    )
    assert r.status_code == 201
    user_headers = invite_user(client, headers, "bascula@x.es", ["Báscula"])
    me = client.get("/api/v1/me", headers=user_headers).json()
    assert me["permissions"] == {"cargas.pesar": "all"}
    assert client.get("/api/v1/users", headers=user_headers).status_code == 403


def test_rol_cuando_permiso_de_modulo_inactivo_entonces_rechazado(client, tenant_admin):
    _, headers = tenant_admin
    r = client.post(
        "/api/v1/roles",
        headers=headers,
        json={"name": "CRM", "permissions": {"crm.ver": "own"}},
    )
    assert r.json()["error"]["code"] == "MODULE_DISABLED"


def test_rol_cuando_permiso_sin_alcance_y_piden_own_entonces_se_guarda_all(client, tenant_admin):
    _, headers = tenant_admin
    r = client.post(
        "/api/v1/roles",
        headers=headers,
        json={"name": "R", "permissions": {"pedidos.ver": "own", "pedidos.validar": "own"}},
    )
    assert r.json()["permissions"] == {"pedidos.ver": "own", "pedidos.validar": "all"}


def test_rol_cuando_es_el_unico_que_gestiona_roles_entonces_no_se_puede_quitar(
    client, tenant_admin
):
    _, headers = tenant_admin
    admin_role = next(
        r
        for r in client.get("/api/v1/roles", headers=headers).json()
        if r["name"] == "Administrador"
    )
    r = client.patch(
        f"/api/v1/roles/{admin_role['id']}",
        headers=headers,
        json={"permissions": {"usuarios.ver": "all"}},
    )
    assert r.json()["error"]["code"] == "LAST_ADMIN_ROLE"


def test_borrar_rol_cuando_tiene_usuarios_entonces_409(client, tenant_admin):
    _, headers = tenant_admin
    invite_user(client, headers, "c@x.es", ["Comercial"])
    comercial = next(
        r for r in client.get("/api/v1/roles", headers=headers).json() if r["name"] == "Comercial"
    )
    assert client.delete(f"/api/v1/roles/{comercial['id']}", headers=headers).status_code == 409


def test_invitar_cuando_email_ya_existe_en_otra_empresa_entonces_409(client, make_tenant):
    _, email_a = make_tenant("Piensos Norte")
    _, email_b = make_tenant("Piensos Sur")
    headers_b = auth(client, email_b)
    role = client.get("/api/v1/roles", headers=headers_b).json()[0]
    r = client.post(
        "/api/v1/users",
        headers=headers_b,
        json={"email": email_a, "full_name": "X", "role_ids": [role["id"]]},
    )
    assert r.status_code == 409


def test_modulo_cuando_no_esta_en_el_plan_entonces_empresa_no_puede_activarlo(client, tenant_admin):
    _, headers = tenant_admin
    r = client.put("/api/v1/tenant/modules/crm", headers=headers, json={"enabled": True})
    assert r.json()["error"]["code"] == "MODULE_NOT_AVAILABLE"


def test_empresa_en_impago_cuando_modifica_entonces_402_y_puede_leer(client, make_tenant):
    _, admin_email = make_tenant(status=TenantStatus.PAST_DUE)
    headers = auth(client, admin_email)
    assert client.get("/api/v1/users", headers=headers).status_code == 200
    r = client.post("/api/v1/roles", headers=headers, json={"name": "X"})
    assert r.status_code == 402


def test_auditoria_cuando_se_crea_rol_entonces_queda_registrado(client, tenant_admin):
    _, headers = tenant_admin
    client.post("/api/v1/roles", headers=headers, json={"name": "Auditado"})
    actions = [a["action"] for a in client.get("/api/v1/audit", headers=headers).json()["items"]]
    assert "rol.crear" in actions


def test_dashboard_cuando_sin_personalizar_entonces_usa_el_del_rol_y_se_puede_restaurar(
    client, tenant_admin
):
    _, headers = tenant_admin
    comercial = invite_user(client, headers, "c@x.es", ["Comercial"])
    board = client.get("/api/v1/me/dashboard", headers=comercial).json()
    assert board["customized"] is False
    widgets = [w["widget"] for w in board["layout"]]
    assert widgets == ["bienvenida", "notificaciones", "accesos_rapidos"]
    # El comercial no tiene usuarios.ver: no puede añadir el resumen de empresa
    assert "resumen_empresa" not in {w["code"] for w in board["catalog"]}

    saved = client.put(
        "/api/v1/me/dashboard",
        headers=comercial,
        json={
            "layout": [
                {"widget": "notificaciones", "size": "lg"},
                {"widget": "resumen_empresa", "size": "sm"},
            ]
        },
    ).json()
    assert saved["customized"] is True
    assert saved["layout"] == [{"widget": "notificaciones", "size": "lg"}]

    reset = client.delete("/api/v1/me/dashboard", headers=comercial).json()
    assert reset["customized"] is False


def test_resumen_empresa_cuenta_usuarios(client, tenant_admin):
    _, headers = tenant_admin
    invite_user(client, headers, "c@x.es", ["Comercial"])
    get_user("c@x.es")
    summary = client.get("/api/v1/tenant/summary", headers=headers).json()
    assert summary["users"] == 2
    assert summary["roles"] == 5
