"""Catálogo fijo de módulos, permisos, plantillas de rol y widgets.

Los roles de cada empresa se construyen eligiendo permisos de este catálogo; el
catálogo en sí solo cambia con el código. Los permisos que pertenecen a un
módulo opcional solo se pueden conceder si la empresa tiene ese módulo activo.
"""

from dataclasses import dataclass, field
from enum import StrEnum


class Scope(StrEnum):
    OWN = "own"  # solo lo suyo (p. ej. un comercial ve sus clientes y pedidos)
    ALL = "all"


@dataclass(frozen=True)
class Module:
    code: str
    name: str
    description: str
    optional: bool  # False = siempre activo; True = se activa por empresa


@dataclass(frozen=True)
class Permission:
    code: str
    area: str
    name: str
    module: str = "core"
    scoped: bool = False  # admite alcance "propios"


MODULES: dict[str, Module] = {
    m.code: m
    for m in [
        Module("core", "Base", "Usuarios, roles, notificaciones y configuración.", False),
        Module("ventas", "Pedidos", "Pedidos de los comerciales.", False),
        Module("fabrica", "Fábrica y stock", "Stock y órdenes de fabricación.", False),
        Module("logistica", "Logística", "Planificación, cargas y albaranes.", False),
        Module("facturacion", "Facturación", "Facturas, abonos y Verifactu.", False),
        Module(
            "formulas_lotes",
            "Fórmulas y lotes",
            "Fórmulas por pienso, consumo de materias primas, lotes y trazabilidad.",
            True,
        ),
        Module("ia", "Asistente de IA", "Consultas, pedidos por voz y propuesta de cargas.", True),
        Module("crm", "CRM del comercial", "Visitas, oportunidades y objetivos de venta.", True),
        Module(
            "mantenimiento",
            "Mantenimiento de planta y flota",
            "Revisiones, averías y vencimientos de máquinas y camiones.",
            True,
        ),
        Module("verifactu_envio", "Envío Verifactu", "Envío de registros a la AEAT.", True),
        Module("conector_erp", "Conector ERP", "Envío de facturas al ERP contable.", True),
    ]
}

OPTIONAL_MODULES = [m.code for m in MODULES.values() if m.optional]

PERMISSIONS: dict[str, Permission] = {
    p.code: p
    for p in [
        # Base
        Permission("usuarios.ver", "Usuarios", "Ver usuarios"),
        Permission("usuarios.gestionar", "Usuarios", "Invitar, editar y desactivar usuarios"),
        Permission("roles.gestionar", "Usuarios", "Crear y editar roles y permisos"),
        Permission(
            "empresa.configurar", "Configuración", "Datos de la empresa, módulos y seguridad"
        ),
        Permission("inicio.configurar_roles", "Configuración", "Pantalla inicial de cada rol"),
        Permission("notificaciones.configurar", "Configuración", "Avisos y canales de la empresa"),
        Permission("auditoria.ver", "Configuración", "Ver el registro de actividad"),
        # Maestros
        Permission("maestros.ver", "Maestros", "Ver clientes, productos, camiones…", scoped=True),
        Permission("maestros.gestionar", "Maestros", "Crear y editar maestros"),
        # Pedidos
        Permission("pedidos.ver", "Pedidos", "Ver pedidos", "ventas", scoped=True),
        Permission("pedidos.crear", "Pedidos", "Crear y editar pedidos", "ventas", scoped=True),
        Permission("pedidos.validar", "Pedidos", "Validar o rechazar pedidos", "ventas"),
        # Fábrica
        Permission("stock.ver", "Fábrica", "Ver stock", "fabrica"),
        Permission("stock.ajustar", "Fábrica", "Entradas, ajustes e inventarios", "fabrica"),
        Permission("fabricacion.ver", "Fábrica", "Ver órdenes de fabricación", "fabrica"),
        Permission("fabricacion.gestionar", "Fábrica", "Gestionar la fabricación", "fabrica"),
        Permission("formulas.gestionar", "Fábrica", "Crear y editar fórmulas", "formulas_lotes"),
        Permission("lotes.trazabilidad", "Fábrica", "Consultar trazabilidad", "formulas_lotes"),
        # Logística
        Permission("logistica.ver", "Logística", "Ver la planificación y las cargas", "logistica"),
        Permission("logistica.planificar", "Logística", "Crear y asignar cargas", "logistica"),
        Permission(
            "cargas.pesar", "Logística", "Registrar pesadas y emitir albaranes", "logistica"
        ),
        # Facturación
        Permission("facturas.ver", "Facturación", "Ver facturas y abonos", "facturacion", True),
        Permission("facturas.emitir", "Facturación", "Emitir facturas", "facturacion"),
        Permission("facturas.abonar", "Facturación", "Emitir abonos", "facturacion"),
        # IA
        Permission("ia.usar", "IA", "Usar el asistente de IA", "ia"),
        Permission("ia.configurar", "IA", "Proveedor y clave de IA", "ia"),
        # CRM
        Permission("crm.ver", "CRM", "Ver visitas y oportunidades", "crm", scoped=True),
        Permission("crm.gestionar", "CRM", "Registrar visitas y oportunidades", "crm", True),
        Permission("crm.objetivos", "CRM", "Fijar objetivos de venta", "crm"),
        # Mantenimiento
        Permission(
            "mantenimiento.ver", "Mantenimiento", "Ver equipos y revisiones", "mantenimiento"
        ),
        Permission(
            "mantenimiento.gestionar",
            "Mantenimiento",
            "Gestionar revisiones y averías",
            "mantenimiento",
        ),
        # Integraciones
        Permission("integraciones.gestionar", "Integraciones", "Conector ERP", "conector_erp"),
    ]
}


@dataclass(frozen=True)
class Widget:
    code: str
    name: str
    description: str
    permission: str | None = None
    module: str = "core"


# Widgets de la pantalla inicial. Cada fase añade los suyos.
WIDGETS: dict[str, Widget] = {
    w.code: w
    for w in [
        Widget("bienvenida", "Bienvenida", "Saludo y resumen del día."),
        Widget("accesos_rapidos", "Accesos rápidos", "Atajos a las acciones más usadas."),
        Widget("notificaciones", "Últimos avisos", "Las notificaciones más recientes."),
        Widget(
            "resumen_empresa",
            "Resumen de la empresa",
            "Usuarios, roles y módulos activos.",
            permission="usuarios.ver",
        ),
        Widget(
            "stock_por_silo",
            "Stock por silo",
            "Lo que hay ahora en cada silo y almacén.",
            permission="stock.ver",
            module="fabrica",
        ),
        Widget(
            "roturas_stock",
            "Roturas de stock",
            "Artículos por debajo de su stock mínimo.",
            permission="stock.ver",
            module="fabrica",
        ),
        Widget(
            "fabricacion_hoy",
            "Fabricación de hoy",
            "Órdenes de fabricación previstas para hoy.",
            permission="fabricacion.ver",
            module="fabrica",
        ),
    ]
}


@dataclass(frozen=True)
class RoleTemplate:
    name: str
    description: str
    permissions: dict[str, Scope]
    widgets: list[str] = field(default_factory=list)


def _all(*codes: str) -> dict[str, Scope]:
    return {c: Scope.ALL for c in codes}


ROLE_TEMPLATES: list[RoleTemplate] = [
    RoleTemplate(
        "Administrador",
        "Acceso completo a la empresa.",
        _all(*PERMISSIONS.keys()),
        ["bienvenida", "resumen_empresa", "notificaciones", "accesos_rapidos"],
    ),
    RoleTemplate(
        "Dirección",
        "Visión global: consulta todo y valida.",
        _all(
            "usuarios.ver",
            "auditoria.ver",
            "maestros.ver",
            "pedidos.ver",
            "pedidos.validar",
            "stock.ver",
            "fabricacion.ver",
            "logistica.ver",
            "facturas.ver",
            "lotes.trazabilidad",
            "ia.usar",
            "crm.ver",
            "crm.objetivos",
            "mantenimiento.ver",
        ),
        ["bienvenida", "resumen_empresa", "roturas_stock", "notificaciones"],
    ),
    RoleTemplate(
        "Oficina",
        "Valida pedidos, factura y planifica.",
        _all(
            "maestros.ver",
            "maestros.gestionar",
            "pedidos.ver",
            "pedidos.crear",
            "pedidos.validar",
            "stock.ver",
            "logistica.ver",
            "logistica.planificar",
            "facturas.ver",
            "facturas.emitir",
            "facturas.abonar",
            "ia.usar",
            "crm.ver",
        ),
        ["bienvenida", "notificaciones", "accesos_rapidos"],
    ),
    RoleTemplate(
        "Fábrica",
        "Fabricación, stock y carga de camiones.",
        _all(
            "maestros.ver",
            "stock.ver",
            "stock.ajustar",
            "fabricacion.ver",
            "fabricacion.gestionar",
            "formulas.gestionar",
            "lotes.trazabilidad",
            "logistica.ver",
            "cargas.pesar",
            "ia.usar",
            "mantenimiento.ver",
            "mantenimiento.gestionar",
        ),
        [
            "bienvenida",
            "fabricacion_hoy",
            "stock_por_silo",
            "roturas_stock",
            "notificaciones",
            "accesos_rapidos",
        ],
    ),
    RoleTemplate(
        "Comercial",
        "Sus clientes y sus pedidos.",
        {
            "maestros.ver": Scope.OWN,
            "pedidos.ver": Scope.OWN,
            "pedidos.crear": Scope.OWN,
            "facturas.ver": Scope.OWN,
            "stock.ver": Scope.ALL,
            "ia.usar": Scope.ALL,
            "crm.ver": Scope.OWN,
            "crm.gestionar": Scope.OWN,
        },
        ["bienvenida", "notificaciones", "accesos_rapidos"],
    ),
]


@dataclass(frozen=True)
class NotificationType:
    code: str
    name: str
    in_app: bool = True
    email: bool = False
    push: bool = False


# Tipos de aviso y canales por defecto. Cada fase añade los suyos.
NOTIFICATION_TYPES: dict[str, NotificationType] = {
    n.code: n
    for n in [
        NotificationType("sistema", "Avisos del sistema", email=True),
        NotificationType("usuario_alta", "Nuevo usuario en la empresa"),
        NotificationType("seguridad", "Seguridad de la cuenta", email=True),
        NotificationType("stock_bajo", "Stock por debajo del mínimo", push=True),
    ]
}
