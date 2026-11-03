import {
  BrainCircuit,
  ClipboardList,
  Factory,
  FileCheck2,
  Handshake,
  Truck,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface LandingModule {
  title: string;
  description: string;
  icon: LucideIcon;
  optional?: boolean;
}

export const MODULES: LandingModule[] = [
  {
    title: "Stock y fabricación",
    description:
      "Stock por silo con libro de movimientos inmutable, entradas de materia prima con pesada de báscula y órdenes de fabricación. Fórmulas y lotes con trazabilidad completa cuando los necesites.",
    icon: Factory,
  },
  {
    title: "Pedidos de comerciales",
    description:
      "El comercial registra el pedido desde el móvil con la tarifa del cliente; oficina lo valida y queda listo para planificar. Cada paso queda registrado.",
    icon: ClipboardList,
  },
  {
    title: "Logística y cargas",
    description:
      "Tablero de planificación diario que agrupa pedidos en cargas por camión y compartimento, órdenes de carga para fábrica, pesada real y albarán en PDF.",
    icon: Truck,
  },
  {
    title: "Facturación con Verifactu",
    description:
      "Facturas desde albaranes, abonos rectificativos, series correlativas y registro de facturación con huella encadenada y QR, preparado desde el primer día.",
    icon: FileCheck2,
  },
  {
    title: "Asistente de IA",
    description:
      "Tu empresa pone su propia clave de Claude, Gemini o ChatGPT. Consultas en lenguaje natural, pedidos por voz o texto y propuesta de cargas, siempre revisables por una persona.",
    icon: BrainCircuit,
    optional: true,
  },
  {
    title: "CRM del comercial",
    description:
      "Mapa de clientes y explotaciones, agenda de visitas, oportunidades y objetivos de venta en la pantalla inicial de cada comercial.",
    icon: Handshake,
    optional: true,
  },
  {
    title: "Mantenimiento de planta y flota",
    description:
      "Planes preventivos, averías, ITV y tacógrafo con aviso previo. Un camión en taller o con la ITV caducada no se puede asignar a una carga.",
    icon: Wrench,
    optional: true,
  },
];

export interface LandingProfile {
  title: string;
  description: string;
  items: string[];
}

export const PROFILES: LandingProfile[] = [
  {
    title: "Comercial",
    description: "Vende sin llamar a la oficina.",
    items: ["Pedidos desde el móvil", "Sus clientes y su tarifa", "Estado de cada pedido"],
  },
  {
    title: "Fábrica",
    description: "Sabe qué cargar y qué fabricar.",
    items: ["Órdenes de carga del día", "Stock por silo", "Pesada y albarán"],
  },
  {
    title: "Oficina",
    description: "Valida, factura y cierra.",
    items: ["Validación de pedidos", "Facturas y abonos", "Aviso de roturas de stock"],
  },
  {
    title: "Dirección",
    description: "Ve el negocio de un vistazo.",
    items: ["Facturación del mes", "Cargas y entregas", "Actividad y permisos"],
  },
];

export interface LandingPlan {
  name: string;
  tagline: string;
  features: string[];
  highlighted?: boolean;
}

export const PLANS: LandingPlan[] = [
  {
    name: "Esencial",
    tagline: "Para empezar a ordenar la fábrica.",
    features: ["Stock y producto terminado", "Pedidos y logística", "Facturas y abonos", "Roles y avisos"],
  },
  {
    name: "Profesional",
    tagline: "El más elegido por fábricas medianas.",
    features: ["Todo lo de Esencial", "Fórmulas y lotes con trazabilidad", "Asistente de IA con tu clave", "CRM y mantenimiento"],
    highlighted: true,
  },
  {
    name: "A medida",
    tagline: "Para grupos y necesidades especiales.",
    features: ["Varias plantas", "Conector con tu ERP contable", "Envío Verifactu a la AEAT", "Soporte prioritario"],
  },
];
