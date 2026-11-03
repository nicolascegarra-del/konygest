from uuid import UUID

from celery import Celery

import app.models  # noqa: F401  (registra los modelos)
from app.core.config import get_settings

settings = get_settings()

celery_app = Celery("konygest", broker=settings.redis_url, backend=settings.redis_url)
celery_app.conf.update(task_acks_late=True, worker_prefetch_multiplier=1, timezone="UTC")


@celery_app.task(name="email.send", autoretry_for=(OSError,), retry_backoff=True, max_retries=5)
def send_email_task(tenant_id: str | None, to: str, subject: str, html: str) -> None:
    from app.modules.platform.email import send_email_now

    send_email_now(UUID(tenant_id) if tenant_id else None, to, subject, html)
