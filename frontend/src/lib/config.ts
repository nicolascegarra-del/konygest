// `||` y no `??`: Coolify pasa como cadena vacía las variables que existen sin valor,
// y una URL vacía rompe el build (metadataBase, sitemap).
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "Konygest";
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
export const API_PREFIX = "/api/v1";
