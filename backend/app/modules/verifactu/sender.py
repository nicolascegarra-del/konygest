"""Remisión de registros de facturación a la AEAT (VERI*FACTU).

La emisión de facturas no depende del envío: el registro y su huella se generan y se
guardan siempre, y el envío es un paso posterior y reintentable. Por eso el envío va
detrás de una interfaz y, mientras no esté configurado, se usa `DisabledSender`.

Lo que hará la implementación real (fase 7), pendiente de verificar contra el WSDL/XSD
vigente de SuministroLR.xsd y SuministroInformacion.xsd de la AEAT:

- Construir el XML `RegFactuSistemaFacturacion` con la cabecera (ObligadoEmision) y uno
  o varios `RegistroFactura` (RegistroAlta / RegistroAnulacion), reutilizando
  `format_amount`, `format_date` y `format_timestamp` de `hashing` para que los valores
  coincidan con la huella; incluir el bloque `Encadenamiento` (PrimerRegistro="S" o
  RegistroAnterior) y los datos del `SistemaInformatico`.
- Enviarlo por SOAP con autenticación TLS mediante el certificado electrónico del
  obligado (o de su representante) a los endpoints de pruebas o producción.
- Respetar los límites del servicio: como máximo 1.000 registros por envío y el tiempo
  de espera entre envíos que devuelve la AEAT (`TiempoEsperaEnvio`).
- Interpretar la respuesta: estado global del envío y estado de cada registro
  (correcto, aceptado con errores, incorrecto) y guardar el CSV del envío.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Protocol

from app.modules.verifactu.hashing import ChainedRecord


class SendStatus(StrEnum):
    # VERIFICAR los literales de EstadoEnvio/EstadoRegistro contra el XSD de respuesta.
    NOT_SENT = "not_sent"  # no se ha llegado a enviar (módulo desactivado, sin conexión...)
    CORRECT = "correct"  # EstadoEnvio = Correcto
    PARTIALLY_CORRECT = "partially_correct"  # EstadoEnvio = ParcialmenteCorrecto
    INCORRECT = "incorrect"  # EstadoEnvio = Incorrecto


@dataclass(frozen=True, slots=True)
class RecordError:
    """Error que la AEAT devuelve para un registro concreto del envío."""

    index: int  # posición del registro dentro del envío
    code: str
    message: str
    accepted: bool  # True = «aceptado con errores» (no hay que reenviarlo)


@dataclass(frozen=True, slots=True)
class SendResult:
    status: SendStatus
    message: str
    csv: str | None = None  # código seguro de verificación del envío
    errors: tuple[RecordError, ...] = field(default_factory=tuple)
    retry_after_seconds: int | None = None  # TiempoEsperaEnvio

    @property
    def sent(self) -> bool:
        return self.status != SendStatus.NOT_SENT


class VerifactuSender(Protocol):
    """Envía a la AEAT un lote de registros ya encadenados, en el orden de la cadena."""

    def send(self, records: Sequence[ChainedRecord]) -> SendResult: ...


class DisabledSender:
    """Envío desactivado (valor por defecto): no contacta con la AEAT.

    Los registros quedan pendientes de envío y se podrán remitir cuando se active el
    módulo, sin recalcular nada: la huella no depende del envío.
    """

    def send(self, records: Sequence[ChainedRecord]) -> SendResult:
        return SendResult(
            status=SendStatus.NOT_SENT,
            message=f"No enviado: módulo VERI*FACTU desactivado ({len(records)} registros).",
        )
