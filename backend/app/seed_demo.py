"""Datos de demostración para desarrollo local: una fábrica con un usuario por perfil.

Uso: `uv run python -m app.seed_demo <contraseña>` (mínimo 6 caracteres; solo
para tu base de datos local). Es idempotente: si la empresa ya existe, no hace nada.
Usuarios creados: <perfil>@demo.konygest.es (admin, direccion, oficina, fabrica, comercial).
"""

import sys

from sqlmodel import select

import app.models  # noqa: F401
from app.core.config import get_settings
from app.core.db import new_session
from app.core.security import hash_password
from app.modules.tenants.models import Tenant, TenantStatus
from app.modules.tenants.service import seed_roles
from app.modules.users.models import User, UserRole

DEMO_TENANT = "Piensos Demo"
DEMO_USERS = {
    "admin": ("Ana Administradora", "Administrador"),
    "direccion": ("Diego Director", "Dirección"),
    "oficina": ("Olga Oficina", "Oficina"),
    "fabrica": ("Fernando Fábrica", "Fábrica"),
    "comercial": ("Carlos Comercial", "Comercial"),
}


def main(password: str) -> None:
    if get_settings().is_production:
        raise SystemExit("No se cargan datos de demostración en producción.")
    with new_session(bypass_rls=True) as db:
        if db.exec(select(Tenant).where(Tenant.name == DEMO_TENANT)).first():
            print("La empresa de demostración ya existe.")
            return
        tenant = Tenant(name=DEMO_TENANT, tax_id="B00000000", status=TenantStatus.ACTIVE)
        db.add(tenant)
        db.flush()
        roles = seed_roles(db, tenant.id)
        password_hash = hash_password(password)
        for key, (name, role) in DEMO_USERS.items():
            user = User(
                tenant_id=tenant.id,
                email=f"{key}@demo.konygest.es",
                full_name=name,
                password_hash=password_hash,
            )
            db.add(user)
            db.flush()
            db.add(UserRole(tenant_id=tenant.id, user_id=user.id, role_id=roles[role].id))
        db.commit()
        print(f"Creada «{DEMO_TENANT}» con usuarios: {', '.join(DEMO_USERS)}@demo.konygest.es")


if __name__ == "__main__":
    if len(sys.argv) != 2 or len(sys.argv[1]) < 6:
        raise SystemExit("Uso: python -m app.seed_demo <contraseña de al menos 6 caracteres>")
    main(sys.argv[1])
