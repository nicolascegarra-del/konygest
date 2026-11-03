# Konygest — Plan de construcción

## Contexto
Una fábrica de piensos a granel necesita gestionar en una sola app: stock de fábrica, fabricación, pedidos de los comerciales, logística (planificación y órdenes de carga), facturas y abonos, con un enlace futuro a un ERP contable aún desconocido. Habrá cuatro perfiles (comercial, fábrica, oficina, dirección), cada uno con una pantalla inicial propia y configurable, y un asistente de IA en el que cada empresa pone su propia clave (Claude, Gemini o ChatGPT).

Decisiones ya tomadas con el usuario:
- Repositorio nuevo **`C:\dev\konygest`** (nada que ver con app-entrenos).
- **SaaS multi-empresa** (cada fábrica es un tenant aislado).
- Fabricación: **módulo de fórmulas y lotes activable**; si está apagado, se registra solo el producto terminado.
- Facturación **preparada para Verifactu** desde el primer día.
- **Siempre online**: web responsive, sin PWA offline.
- IA: **cada empresa mete su clave**; usos: asistente de consultas, planificación de cargas y pedidos por voz/texto.
- **Roles configurables** con permisos por módulo; **un usuario pertenece a una sola empresa**.
- **Login** propio, **notificaciones** (en la app, email y push) elegibles por empresa y por usuario, **landing pública** de la app.
- **Cobro de la suscripción SaaS** a cada fábrica, con pasarela aún por decidir.

## Stack (estándar Klyp)
- Backend: FastAPI + SQLModel + PostgreSQL 16 + Alembic, Redis + Celery (PDF, envíos, IA larga), MinIO (PDF de albaranes y facturas), WeasyPrint.
- Frontend: Next.js 15 (App Router) + TypeScript estricto + Tailwind v4 + shadcn/ui + TanStack Query + Zustand + RHF/Zod + Lucide. Colores Klyp, modo oscuro por `class`.
- Infra: Docker Compose (api, worker, web, postgres, redis, minio), despliegue en Coolify, CI en GitHub Actions (ruff + pytest, eslint + tsc + vitest, build).

## Estructura
```
konygest/
├── backend/app/
│   ├── core/        # config, seguridad JWT, tenant, permisos, cifrado
│   ├── modules/     # un paquete por dominio: models, schemas, service, router
│   │   ├── tenants, users, masters, stock, production, formulas,
│   │   ├── orders, logistics, invoicing, verifactu, dashboard, ai, integrations
│   ├── tasks/       # Celery
│   └── main.py
├── frontend/src/app/(app)/{inicio,pedidos,fabrica,logistica,facturacion,maestros,ajustes}
├── docker-compose.yml, .env.example, README.md
```

## Base transversal
- **Multi-empresa**: `tenant_id` en todas las tablas + Row Level Security de PostgreSQL (la sesión fija `app.tenant_id` por petición); índices compuestos `(tenant_id, …)`.
- **Módulos por empresa**: tabla `tenant_module` (fórmulas_lotes, ia, verifactu_envio, conector_erp). El backend comprueba el módulo con una dependencia y el frontend oculta menús.
- **Login**: email + contraseña (bcrypt coste 12), access JWT de 15 min en memoria y refresh de 7 días en cookie HttpOnly `SameSite=Strict`, recuperación de contraseña por email, invitación de usuarios por enlace, bloqueo y rate limiting tras intentos fallidos, 2FA (TOTP) opcional que la empresa puede hacer obligatorio, cierre de sesiones activas.
- **Roles configurables**: catálogo fijo de permisos agrupados por módulo y acción (`pedidos.ver`, `pedidos.crear`, `pedidos.validar`, `facturas.emitir`, `ajustes.ia`…) y alcance (propios / todos). Cada empresa crea y edita sus roles en una matriz módulo × acción; vienen precargados Comercial, Fábrica, Oficina, Dirección y Administrador como plantillas editables. Un usuario = una empresa, con uno o varios roles en ella. Los permisos de un módulo apagado no se pueden conceder.
- **Panel de administración de Klyp** (ruta `/admin`, solo roles de plataforma superadmin/soporte, con 2FA obligatorio; es el único acceso que cruza empresas):
  - Listado de empresas con estado (prueba, activa, impago, desactivada), plan, nº de usuarios, último acceso y uso de IA; buscador y filtros.
  - Alta de empresa con su primer administrador (invitación por email), **activar/desactivar** empresa (desactivada = nadie puede entrar; los datos se conservan), activar módulos y asignar plan.
  - **Configuración de email**: SMTP global de la plataforma (servidor, puerto, usuario, contraseña cifrada, remitente) con botón de envío de prueba; cada empresa puede usar el global o poner su propio SMTP/remitente. Plantillas de los emails de sistema (invitación, recuperación, avisos).
  - Modo soporte: entrar en una empresa para ayudar, con aviso visible y registro en auditoría.
  - Métricas globales: empresas activas, usuarios, documentos emitidos, errores de envío de emails y de integraciones.
- **Pantalla inicial configurable**: catálogo de widgets (p. ej. «mis pedidos pendientes», «stock por silo», «cargas de hoy», «facturación del mes», «roturas de stock»). El admin define el layout por defecto de cada rol (JSON en `dashboard_layout`) y cada usuario puede personalizar el suyo (arrastrar con dnd-kit, mostrar/ocultar); botón «restaurar el del rol».
- **Notificaciones**: los módulos emiten eventos (pedido pendiente de validar, pedido confirmado, carga asignada, carga lista, stock bajo mínimo, factura emitida, envío al ERP fallido…). Un servicio los convierte en avisos por tres canales: **en la app** (campana con contador, tiempo real por SSE), **email** (plantillas, envío por Celery vía SMTP configurable) y **push** (Web Push con claves VAPID, móvil y escritorio). La empresa decide qué tipos y canales están disponibles y sus valores por defecto por rol; cada usuario ajusta los suyos en su perfil dentro de lo permitido.
- **Auditoría**: tabla de eventos con quién/qué/cuándo en documentos clave.

## Dominio por módulos
1. **Maestros**: clientes, explotaciones (código REGA, dirección, silos de destino), comerciales, productos (piensos), materias primas, almacenes/silos de fábrica, tarifas y precios por cliente, transportistas, camiones (compartimentos y capacidad), conductores, IVA y formas de pago. Unidades en kg.
2. **Stock**: libro de movimientos inmutable (entrada de materia prima, producción, consumo, salida por carga, ajuste, inventario); el stock es la suma por artículo/silo/lote. Entradas de materia prima con pesada de báscula (bruto/tara/neto) introducida a mano.
3. **Fabricación**: órdenes de fabricación (planificada → en curso → terminada). Sin módulo: alta de producto terminado. Con módulo **Fórmulas y lotes**: fórmulas versionadas por pienso (% de cada materia prima), consumo automático de materia prima, lote de producción y trazabilidad hacia atrás (qué lotes de materia prima) y hacia delante (qué clientes recibieron el lote), como pide el Reglamento 183/2005.
4. **Pedidos**: el comercial crea el pedido (cliente, explotación, producto, kg, fecha deseada, precio de tarifa o negociado). Estados: borrador → pendiente de validar (oficina comprueba riesgo y precio) → confirmado → planificado → cargado → entregado → facturado.
5. **Logística**: tablero de planificación por día que agrupa pedidos confirmados en **cargas** (camión, compartimentos, ruta, orden de descarga). Cada carga genera la **orden de carga** para fábrica; fábrica registra la pesada real y se emite el **albarán / documento de acompañamiento** en PDF. Confirmación de entrega.
6. **Facturación**: factura desde albaranes (por carga o agrupada por cliente y periodo), series y numeración correlativa, vencimientos; **abonos** (rectificativas R1–R5) totales o parciales. PDF en MinIO.
7. **Verifactu**: en cada emisión o anulación se crea un registro de facturación con huella SHA-256 encadenada a la anterior, QR en el PDF y registro de eventos. Las facturas emitidas no se editan, se rectifican. El envío a la AEAT va en un adaptador (`VerifactuSender`) desactivado por defecto; se activa con el módulo y el certificado de la empresa.
8. **Integración ERP**: patrón *outbox*: facturas, abonos, clientes y cobros se publican como eventos en `integration_outbox`; un worker los entrega mediante un conector (`AccountingConnector`). De salida: exportación CSV/Excel y webhook JSON genérico, con tabla de mapeo de cuentas contables (cliente, ventas, IVA). Cuando se sepa el ERP solo se añade su conector.

9. **Suscripción SaaS**: planes (usuarios máximos, módulos incluidos, precio mensual/anual), suscripción por empresa con estados (prueba → activa → impago → suspendida, con aviso previo y acceso de solo lectura al suspender). El cobro va detrás de una interfaz `PaymentGateway`: se empieza con cobro **manual** (Klyp emite la factura y marca el pago en el panel) y, cuando se decida la pasarela (Stripe, Redsys, domiciliación SEPA con GoCardless…), se añade su adaptador y sus webhooks.
10. **CRM del comercial** (módulo activable en la configuración de la empresa): mapa de clientes y explotaciones, agenda de visitas con resultado y notas, oportunidades (posibles clientes y su estado), objetivos de venta por comercial con seguimiento en su pantalla inicial. Al apagarlo desaparecen menús, widgets y permisos.
11. **Mantenimiento de planta y flota** (módulo activable): ficha de cada máquina de la planta y de cada camión; planes preventivos por tiempo, horas o kilómetros; órdenes de trabajo para averías y revisiones (quién, coste, piezas, tiempo parado); vencimientos de ITV, tacógrafo, seguros y revisiones con aviso previo por notificación. Un camión en taller o con la ITV caducada no se puede asignar a una carga.
12. **Landing pública**: página de presentación de Konygest en la raíz del dominio (ruta pública del mismo Next.js, generada estática): propuesta de valor, módulos, perfiles, IA, planes y precios, formulario de contacto/solicitud de demo (con protección antispam), enlace a «Acceder», aviso legal, privacidad y cookies. Identidad visual Klyp, SEO básico (metadatos, Open Graph, sitemap).

## IA (cada empresa con su clave)
- En Ajustes → IA el admin elige el proveedor (Anthropic, Google, OpenAI), el modelo y pega la API key; se guarda **cifrada** (Fernet con clave maestra en variable de entorno) y nunca se devuelve al cliente. Botón «probar conexión».
- Capa `LLMProvider` con tres adaptadores (SDK oficiales `anthropic`, `google-genai`, `openai`) y una interfaz común de chat con *tool calling*.
- La IA **no ejecuta SQL libre**: solo llama a herramientas del dominio (consultar stock, pedidos, clientes, cargas, crear borrador de pedido, proponer cargas) que se ejecutan con los permisos y el tenant del usuario que pregunta.
- Usos:
  - **Asistente de consultas**: panel de chat en toda la app («¿cuánto cebo queda?», «pedidos pendientes de Juan»).
  - **Pedidos por voz/texto**: dictado con la Web Speech API del navegador (vale para cualquier proveedor) o texto pegado (p. ej. un WhatsApp) → la IA rellena un **borrador** que el comercial revisa y confirma.
  - **Planificación de cargas**: la IA propone el reparto de pedidos en camiones y el orden de rutas; el planificador acepta o modifica. Nunca confirma sola.
- Registro de consumo de tokens por empresa y usuario, y límite opcional.
- Al implementar, consultar la skill `claude-api` para modelos e IDs actuales.

## Fases (cada una en ramas `feature/*` → `develop`, PRs pequeños)
0. **Cimientos**: repo, Docker Compose, CI, login completo, empresas, usuarios, roles configurables, RLS, módulos, panel de plataforma, layout con menú según permisos, motor de pantalla inicial configurable y servicio de notificaciones (los módulos posteriores solo añaden sus eventos).
0b. **Landing pública** (puede ir en paralelo a la fase 1).
1. **Maestros + stock + fabricación de producto terminado**.
2. **Pedidos de comerciales** con validación en oficina.
3. **Logística**: planificación, cargas, órdenes de carga, pesada y albarán PDF.
4. **Facturación y abonos** + registro Verifactu (sin envío).
5. **Módulo de fórmulas y lotes** con trazabilidad.
6. **IA**: configuración de clave, asistente, pedidos por voz/texto, propuesta de cargas.
7. **Conector ERP** (exportación genérica + webhook); conector específico cuando se conozca el ERP. Envío Verifactu a la AEAT cuando la empresa lo active.
8. **Suscripción SaaS**: planes, estados y cobro manual; adaptador de pasarela cuando se elija.
9. **Módulo de mantenimiento de planta y flota**.
10. **Módulo CRM del comercial**.

Al terminar la fase 4 ya hay una app usable de punta a punta sin IA ni lotes.

Fuera de alcance por ahora (se pueden añadir como módulos): compras y proveedores, cobros/riesgo/comisiones, entrega con firma del conductor y devoluciones, previsión de silos de granja, GPS de flota, portal del ganadero, calidad/APPCC/medicados, costes y márgenes, báscula automática.

## Verificación
- **Backend (pytest + httpx, cobertura ≥ 70 %)**: aislamiento entre empresas (un usuario no ve datos de otra), permisos de roles personalizados (un permiso quitado devuelve 403), login (bloqueo, refresh, recuperación, 2FA), preferencias de notificación respetadas por canal, cambios de estado de la suscripción, cálculo de stock tras cada tipo de movimiento, consumo por fórmula, ciclo de estados del pedido, huella encadenada de Verifactu (manipular una factura rompe la cadena), abonos que restan, adaptadores de IA con proveedores simulados.
- **Frontend (Vitest + Testing Library, ≥ 60 %)**: widgets y editor de pantalla inicial, formularios de pedido y carga.
- **E2E (Playwright)** por fase: comercial crea pedido → oficina valida → logística arma la carga → fábrica pesa y emite albarán → oficina factura y hace un abono; y la pantalla inicial distinta de cada perfil; crear un rol y comprobar qué ve un usuario con él; recibir el aviso en la campana; landing → «Acceder» → login; desde `/admin`, desactivar una empresa y comprobar que sus usuarios no pueden entrar; enviar un email de prueba con el SMTP configurado; activar CRM y mantenimiento y ver que aparecen sus menús, y que un camión con ITV caducada no se puede cargar.
- **Responsive** en 375, 390, 768, 1024, 1280 y 1440 px.
- Arranque local con `docker compose up` y datos de demostración (una fábrica con clientes, piensos y camiones) para probar a mano.
