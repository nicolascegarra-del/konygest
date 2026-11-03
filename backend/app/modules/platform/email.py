"""Envío de emails con el SMTP de la empresa, el global de la plataforma o el del entorno."""

import logging
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr
from html import escape
from uuid import UUID

from sqlmodel import Session, select

from app.core.config import get_settings
from app.core.db import new_session
from app.core.security import decrypt_secret
from app.modules.platform.models import EmailConfig

logger = logging.getLogger("konygest.email")
settings = get_settings()

# Emails enviados con EMAIL_BACKEND=memory (tests)
outbox: list[EmailMessage] = []


@dataclass
class SmtpSettings:
    host: str
    port: int
    username: str
    password: str
    use_tls: bool
    from_email: str
    from_name: str


def _from_row(row: EmailConfig) -> SmtpSettings:
    return SmtpSettings(
        host=row.host,
        port=row.port,
        username=row.username,
        password=decrypt_secret(row.password_enc) or "" if row.password_enc else "",
        use_tls=row.use_tls,
        from_email=row.from_email,
        from_name=row.from_name,
    )


def resolve_smtp(session: Session, tenant_id: UUID | None) -> SmtpSettings:
    """SMTP propio de la empresa → SMTP global del panel → variables de entorno."""
    if tenant_id:
        own = session.exec(select(EmailConfig).where(EmailConfig.tenant_id == tenant_id)).first()
        if own:
            return _from_row(own)
    platform = session.exec(select(EmailConfig).where(EmailConfig.tenant_id.is_(None))).first()  # type: ignore[union-attr]
    if platform:
        return _from_row(platform)
    return SmtpSettings(
        host=settings.smtp_host,
        port=settings.smtp_port,
        username=settings.smtp_user,
        password=settings.smtp_password,
        use_tls=settings.smtp_use_tls,
        from_email=settings.email_from,
        from_name=settings.email_from_name,
    )


def build_message(smtp: SmtpSettings, to: str, subject: str, html: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = formataddr((smtp.from_name, smtp.from_email))
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content("Abre este correo en un cliente compatible con HTML.")
    msg.add_alternative(html, subtype="html")
    return msg


def deliver(smtp: SmtpSettings, msg: EmailMessage) -> None:
    """Envía de verdad. Lanza la excepción del SMTP si falla (para el botón de prueba)."""
    if settings.email_backend == "memory":
        outbox.append(msg)
        return
    if settings.email_backend == "console":
        logger.info("Email (consola) a %s: %s", msg["To"], msg["Subject"])
        return
    with smtplib.SMTP(smtp.host, smtp.port, timeout=15) as client:
        if smtp.use_tls:
            client.starttls()
        if smtp.username:
            client.login(smtp.username, smtp.password)
        client.send_message(msg)


def send_email_now(tenant_id: UUID | None, to: str, subject: str, html: str) -> None:
    with new_session(bypass_rls=True) as session:
        smtp = resolve_smtp(session, tenant_id)
    deliver(smtp, build_message(smtp, to, subject, html))


def send_email(tenant_id: UUID | None, to: str, subject: str, html: str) -> None:
    """Encola el email en Celery si hay Redis; si no, lo envía en el momento."""
    if settings.redis_url and settings.email_backend == "smtp":
        from app.worker import send_email_task

        send_email_task.delay(str(tenant_id) if tenant_id else None, to, subject, html)
        return
    try:
        send_email_now(tenant_id, to, subject, html)
    except (OSError, smtplib.SMTPException):
        logger.exception("No se pudo enviar el email a %s", to)


def render(title: str, paragraphs: list[str], button: tuple[str, str] | None = None) -> str:
    """Plantilla HTML sencilla con los colores de Klyp. El texto se escapa."""
    body = "".join(f'<p style="margin:0 0 16px">{escape(p)}</p>' for p in paragraphs)
    if button:
        label, url = button
        body += (
            f'<p style="margin:24px 0"><a href="{escape(url, quote=True)}" '
            'style="background:#2E6DB4;color:#fff;padding:12px 20px;border-radius:8px;'
            f'text-decoration:none;font-weight:600">{escape(label)}</a></p>'
            f'<p style="font-size:12px;color:#6B7280">Si el botón no funciona, copia este enlace: '
            f"{escape(url)}</p>"
        )
    return (
        '<div style="font-family:Inter,Arial,sans-serif;background:#E8EDF5;padding:24px">'
        '<div style="max-width:560px;margin:auto;background:#fff;'
        'border-radius:8px;overflow:hidden">'
        '<div style="background:#051937;color:#fff;padding:16px 24px;font-weight:600;'
        'font-size:18px">Konygest</div>'
        f'<div style="padding:24px;color:#374151"><h1 style="font-size:20px;color:#051937;'
        f'margin:0 0 16px">{escape(title)}</h1>{body}</div></div></div>'
    )
