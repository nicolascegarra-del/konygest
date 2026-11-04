"""Documentos: destino de cada empresa, registro de documentos y generación de PDF.

API pública que usan los demás módulos (no importar los submódulos directamente):

- `store(db, tenant_id, kind, number, data, content_type, source_type, source_id)
  -> StoredDocument`: guarda en el destino de la empresa (Google Drive, OneDrive, SMB o el
  almacenamiento de Konygest) y lo registra en `stored_document`. Si el destino falla, se
  guarda en el almacenamiento de Konygest y se avisa (`documentos_error`).
- `fetch(db, tenant_id, kind, number, regenerate) -> bytes`: lee de donde se guardó; si no
  está o el destino no responde, llama a `regenerate()`, lo vuelve a guardar y lo devuelve.
- `stored_numbers(db, tenant_id, kind, numbers) -> set[str]`: qué números tienen fichero.
- `render_loading_order(data)`, `render_delivery_note(data)` y `render_invoice(data)` -> bytes: PDF.
  Lanzan `PdfUnavailableError` si WeasyPrint no puede cargarse (p. ej. Windows sin GTK);
  quien los llama responde 503 `PDF_UNAVAILABLE`.
- `storage`: almacenamiento de Konygest por clave (uso interno y tests).
"""

from app.modules.documents.models import StoredDocument
from app.modules.documents.pdf import (
    PdfUnavailableError,
    render_delivery_note,
    render_invoice,
    render_loading_order,
)
from app.modules.documents.providers.base import StorageProviderError
from app.modules.documents.service import fetch, store
from app.modules.documents.service import numbers_stored as stored_numbers
from app.modules.documents.storage import storage

__all__ = [
    "PdfUnavailableError",
    "StorageProviderError",
    "StoredDocument",
    "fetch",
    "render_delivery_note",
    "render_invoice",
    "render_loading_order",
    "storage",
    "store",
    "stored_numbers",
]
