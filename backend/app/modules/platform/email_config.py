"""Lectura y guardado de la configuración SMTP (global o de una empresa)."""

import smtplib
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field
from sqlmodel import Session, col, select

from app.core.errors import AppError
from app.core.security import encrypt_secret
from app.modules.platform.email import _from_row, build_message, deliver, render
from app.modules.platform.models import EmailConfig


class EmailConfigIn(BaseModel):
    host: str = Field(min_length=1, max_length=200)
    port: int = Field(ge=1, le=65535)
    username: str = Field(default="", max_length=200)
    # Vacío o ausente = conservar la contraseña guardada
    password: str | None = Field(default=None, max_length=200)
    use_tls: bool = True
    from_email: EmailStr
    from_name: str = Field(default="Konygest", max_length=100)


class EmailConfigOut(BaseModel):
    host: str
    port: int
    username: str
    has_password: bool
    use_tls: bool
    from_email: str
    from_name: str


class EmailTestIn(BaseModel):
    to: EmailStr


def _query(tenant_id: UUID | None):
    query = select(EmailConfig)
    if tenant_id is None:
        return query.where(col(EmailConfig.tenant_id).is_(None))
    return query.where(EmailConfig.tenant_id == tenant_id)


def get_config(session: Session, tenant_id: UUID | None) -> EmailConfig | None:
    return session.exec(_query(tenant_id)).first()


def to_out(row: EmailConfig) -> EmailConfigOut:
    return EmailConfigOut(
        host=row.host,
        port=row.port,
        username=row.username,
        has_password=bool(row.password_enc),
        use_tls=row.use_tls,
        from_email=row.from_email,
        from_name=row.from_name,
    )


def save_config(session: Session, tenant_id: UUID | None, data: EmailConfigIn) -> EmailConfig:
    row = get_config(session, tenant_id) or EmailConfig(
        tenant_id=tenant_id, host=data.host, from_email=data.from_email
    )
    row.host = data.host
    row.port = data.port
    row.username = data.username
    row.use_tls = data.use_tls
    row.from_email = data.from_email
    row.from_name = data.from_name
    if data.password:
        row.password_enc = encrypt_secret(data.password)
    session.add(row)
    return row


def send_test(row: EmailConfig, to: str) -> None:
    smtp = _from_row(row)
    html = render(
        "Prueba de correo",
        ["Si lees esto, la configuración de correo de Konygest funciona."],
    )
    try:
        deliver(smtp, build_message(smtp, to, "Prueba de correo de Konygest", html))
    except (OSError, smtplib.SMTPException) as exc:
        raise AppError(
            400, "EMAIL_TEST_FAILED", f"No se pudo enviar: {type(exc).__name__}. Revisa los datos."
        ) from exc
