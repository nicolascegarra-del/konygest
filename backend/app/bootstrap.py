"""Crea el superadmin inicial de Klyp si no hay ninguno.

Uso: `python -m app.bootstrap` (lo ejecuta el contenedor de la API al arrancar).
Toma el email y la contraseña de BOOTSTRAP_SUPERADMIN_EMAIL / _PASSWORD.
"""

import logging

from sqlmodel import col, select

import app.models  # noqa: F401
from app.core.config import get_settings
from app.core.db import new_session
from app.core.security import hash_password
from app.modules.users.models import PlatformRole, User

logger = logging.getLogger("konygest.bootstrap")


def main() -> None:
    settings = get_settings()
    email = settings.bootstrap_superadmin_email.lower().strip()
    if not email or not settings.bootstrap_superadmin_password:
        logger.info("Sin BOOTSTRAP_SUPERADMIN_*: no se crea superadmin.")
        return
    with new_session(bypass_rls=True) as db:
        exists = db.exec(select(User.id).where(col(User.platform_role).is_not(None))).first()
        if exists:
            return
        db.add(
            User(
                email=email,
                full_name="Administrador Klyp",
                password_hash=hash_password(settings.bootstrap_superadmin_password),
                platform_role=PlatformRole.SUPERADMIN,
            )
        )
        db.commit()
        logger.info("Superadmin creado: %s", email)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
