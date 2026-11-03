"""Tipos numéricos de la API.

En la base de datos las cantidades son `Decimal` (sin errores de redondeo); en el
JSON de salida se envían como número para que el frontend no tenga que convertir
cadenas.
"""

from decimal import Decimal
from typing import Annotated

from pydantic import Field, PlainSerializer

_as_number = PlainSerializer(float, return_type=float, when_used="json")

# Kilos (con signo en los movimientos de stock)
Kg = Annotated[Decimal, Field(max_digits=14, decimal_places=2), _as_number]
# Precio en €/kg
Price = Annotated[Decimal, Field(ge=0, max_digits=10, decimal_places=4), _as_number]
# Porcentaje (IVA, recargo...)
Percent = Annotated[Decimal, Field(ge=0, le=100, max_digits=5, decimal_places=2), _as_number]
Money = Annotated[Decimal, Field(ge=0, max_digits=14, decimal_places=2), _as_number]
PositiveKg = Annotated[Decimal, Field(gt=0, max_digits=14, decimal_places=2), _as_number]
NonNegativeKg = Annotated[Decimal, Field(ge=0, max_digits=14, decimal_places=2), _as_number]
