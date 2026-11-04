/** Error de la API convertido desde el formato estándar de Klyp. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | null;
  readonly requestId: string | null;

  constructor(params: {
    status: number;
    code: string;
    message: string;
    field?: string | null;
    requestId?: string | null;
  }) {
    super(params.message);
    this.name = "ApiError";
    this.status = params.status;
    this.code = params.code;
    this.field = params.field ?? null;
    this.requestId = params.requestId ?? null;
  }
}

const FRIENDLY_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "El email o la contraseña no son correctos.",
  TOTP_REQUIRED: "Introduce el código de tu aplicación de autenticación.",
  TOTP_INVALID: "El código no es válido o ha caducado. Inténtalo de nuevo.",
  ACCOUNT_LOCKED: "Cuenta bloqueada temporalmente por demasiados intentos. Espera unos minutos.",
  TENANT_DISABLED: "Tu empresa está desactivada. Contacta con Klyp.",
  RATE_LIMITED: "Demasiados intentos. Espera un momento y vuelve a probar.",
  TWO_FACTOR_SETUP_REQUIRED: "Activa la verificación en dos pasos para continuar.",
  SUBSCRIPTION_PAST_DUE: "La suscripción tiene un pago pendiente: la cuenta está en solo lectura.",
  FORBIDDEN: "No tienes permiso para hacer esto.",
  NOT_FOUND: "No se ha encontrado lo que buscas.",
  MODULE_DISABLED: "Este módulo no está activo en tu empresa.",
  WEAK_PASSWORD: "La contraseña es demasiado débil. Usa al menos 10 caracteres.",
  INVALID_TOKEN: "El enlace no es válido o ha caducado. Solicita uno nuevo.",
  CONFLICT: "Esa operación entra en conflicto con datos existentes.",
  EMAIL_TEST_FAILED: "No se pudo enviar el email de prueba. Revisa la configuración del servidor.",
  INSUFFICIENT_STOCK: "No hay stock suficiente en ese silo: el movimiento lo dejaría en negativo.",
  INVALID_REFERENCE: "Alguno de los datos elegidos no existe o está dado de baja. Revísalo y vuelve a probar.",
  INVALID_ITEM_KIND: "Ese artículo no vale aquí: las entradas son de materias primas; la fabricación y los pedidos, de piensos.",
  INVALID_STATUS: "Ya no está en un estado que permita esta acción (puede que otra persona la haya cambiado). Recarga la página.",
  PRICE_REQUIRED: "El cliente no tiene precio para este pienso: indica el precio a mano.",
  CREDIT_LIMIT_EXCEEDED: "El pedido supera el riesgo (límite de crédito) del cliente.",
  LOAD_DOES_NOT_FIT: "Los pedidos no caben en los compartimentos de este camión. Quita algún pedido o elige un camión más grande.",
  COMPARTMENT_OVERFLOW: "Un compartimento supera su capacidad. Revisa los kilos repartidos.",
  ORDER_NOT_PLANNABLE: "Ese pedido ya no se puede planificar: no está confirmado o ya va en otra carga. Recarga la lista de pendientes.",
  NOT_CONNECTED: "Conecta primero la cuenta (botón «Conectar») antes de guardar este destino.",
  STORAGE_CONNECTION_FAILED: "No se pudo conectar con el destino de los documentos. Revisa los datos y vuelve a probar.",
  PROVIDER_NOT_CONFIGURED: "Este destino no está disponible en la plataforma ahora mismo. Contacta con Klyp.",
  PDF_UNAVAILABLE: "No se pueden generar PDF en este servidor ahora mismo.",
  NETWORK_ERROR: "No hay conexión con el servidor. Comprueba tu red e inténtalo de nuevo.",
};

/** Mensaje en castellano apto para mostrar al usuario a partir de cualquier error. */
export function friendlyMessage(error: unknown): string {
  if (error instanceof ApiError) {
    // Validación y conflictos: el servidor ya explica qué campo o regla falla.
    if (error.code === "VALIDATION_ERROR" || error.code === "CONFLICT") {
      if (error.message) return error.message;
    }
    const known = FRIENDLY_MESSAGES[error.code];
    if (known) return known;
    if (error.message) return error.message;
  }
  return "Ha ocurrido un error inesperado.";
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

/** Mensaje conocido para un código de error (p. ej. el `?error=` de una vuelta de OAuth), si lo hay. */
export function messageForCode(code: string): string | undefined {
  return FRIENDLY_MESSAGES[code];
}
