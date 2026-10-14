export interface ServiceAuthConfig {
  /** api_client name -> bearer token */
  tokens: Record<string, string>;
}

import { normalizePhone } from '../customers/normalize-phone';

export interface AppConfig {
  /** Nombre del negocio, para el título de Swagger y similares. */
  appName: string;
  port: number;
  databaseUrl: string;
  /** Orígenes permitidos por CORS. Vacío = ninguno (el backend queda solo para clientes que no son navegadores). */
  corsOrigins: string[];
  serviceAuth: ServiceAuthConfig;
  gateway: {
    baseUrl: string;
    authToken: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  mapbox: {
    /** Vacío = sin credenciales todavía, DeliveryModule usa haversine (línea recta). */
    accessToken: string;
  };
  s3: {
    /** Vacío (sin bucket) = sin credenciales todavía, las fotos de producto usan disco local. */
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Solo para proveedores S3-compatibles que no son AWS (Cloudflare R2, MinIO, etc.). Vacío = AWS S3. */
    endpoint: string;
  };
  baneco: {
    baseUrl: string;
    username: string;
    password: string;
    aesKey: string;
    account: string;
  };
  /**
   * 'manual' = mientras el banco no habilite producción: el POS nunca le
   * pide un QR real a Baneco, el cajero confirma el cobro a ojo (con SU
   * propio QR fuera del sistema) vía `confirm-presencial`. Solo afecta
   * channel='pos' — WhatsApp sigue con el QR real de Baneco. Interruptor
   * por variable de entorno (no una rama aparte) para no arrastrar un merge
   * divergente: cuando el banco dé el ok, se saca la variable y listo.
   */
  posQrMode: 'bank' | 'manual';
  /** Minutos tras los que un pedido sin pagar se cancela solo (WhatsApp y POS). */
  unpaidOrderTtlMinutes: number;
  /** Horas tras las que un pedido abierto que nadie cerró se cierra solo (entregado / despachado). */
  staleOrderCloseHours: number;
  /**
   * Minutos que una solicitud fuera de horario (late_order_requests) espera la
   * decisión del staff antes de vencer. Si no se define, usa el mismo valor que
   * `unpaidOrderTtlMinutes`.
   */
  lateOrderRequestTtlMinutes: number;
  /** Destino (chat/grupo) del aviso de delivery que el gateway de mensajería sabe resolver. */
  deliveryNoticeChatRef: string;
  /**
   * Teléfonos (normalizados) que saltan el gate de horario SOLO para
   * channel='web' — para probar el checkout fuera de horario sin abrir al
   * público. Vacío por defecto (no seteada en el entorno) = cero cambio de
   * comportamiento. No es un flag que mande el cliente: se resuelve contra
   * el teléfono real del customerId ya existente, server-side.
   * NUNCA cambia business_opens_hour/closesHour ni el gate de caja abierta
   * para pago (solo la creación del pedido).
   */
  aiTestPhones: string[];
  /**
   * Primer admin sin terminal ni acceso a la base: si hay contraseña y todavía
   * no existe ningún admin, la app lo crea al arrancar (ver AdminBootstrapService).
   * Vacía = no hace nada.
   */
  bootstrapAdmin: {
    username: string;
    password: string;
  };
}

function parseServiceAuthTokens(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const entries = raw
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [apiClient, token] = pair.split(':');
      return [apiClient?.trim(), token?.trim()] as [string, string];
    })
    .filter(([apiClient, token]) => Boolean(apiClient) && Boolean(token));
  return Object.fromEntries(entries);
}

function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function parseAiTestPhones(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((phone) => phone.trim())
    .filter(Boolean)
    .map((phone) => normalizePhone(phone, { assumeInternational: true }));
}

/**
 * Variables del storage de objetos: `STORAGE_S3_<name>`. Los despliegues
 * anteriores las tenían como `PAYMENT_PROOFS_S3_<name>` (cuando el bucket
 * también guardaba comprobantes de pago): se siguen aceptando como
 * alternativa para que renombrar el módulo no deje al backend sin bucket —
 * sin credenciales cae a disco local, que en un host efímero pierde las fotos.
 */
function storageS3Env(name: string): string | undefined {
  const current = process.env[`STORAGE_S3_${name}`]?.trim();
  if (current) return current;
  const legacy = process.env[`PAYMENT_PROOFS_S3_${name}`]?.trim();
  return legacy || undefined;
}

function requiredEnv(name: 'DATABASE_URL' | 'JWT_SECRET'): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export default (): AppConfig => ({
  appName: process.env.APP_NAME?.trim() || 'Backend central',
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: requiredEnv('DATABASE_URL'),
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
  serviceAuth: {
    tokens: parseServiceAuthTokens(process.env.SERVICE_AUTH_TOKENS),
  },
  gateway: {
    baseUrl: process.env.GATEWAY_BASE_URL ?? '',
    authToken: process.env.GATEWAY_AUTH_TOKEN ?? '',
  },
  jwt: {
    secret: requiredEnv('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  },
  mapbox: {
    accessToken: process.env.MAPBOX_ACCESS_TOKEN ?? '',
  },
  s3: {
    bucket: storageS3Env('BUCKET') ?? '',
    region: storageS3Env('REGION') ?? 'auto',
    accessKeyId: storageS3Env('ACCESS_KEY_ID') ?? '',
    secretAccessKey: storageS3Env('SECRET_ACCESS_KEY') ?? '',
    endpoint: storageS3Env('ENDPOINT') ?? '',
  },
  baneco: {
    // Sin "/" final: el cliente arma `${baseUrl}/api/...` y una barra de más da 404 en el gateway del banco.
    baseUrl: (process.env.BANECO_BASE_URL ?? '').replace(/\/+$/, ''),
    username: process.env.BANECO_USERNAME ?? '',
    password: process.env.BANECO_PASSWORD ?? '',
    aesKey: process.env.BANECO_AES_KEY ?? '',
    account: process.env.BANECO_ACCOUNT ?? '',
  },
  posQrMode: process.env.POS_QR_MODE === 'manual' ? 'manual' : 'bank',
  unpaidOrderTtlMinutes:
    Number(process.env.UNPAID_ORDER_TTL_MINUTES) > 0 ? Number(process.env.UNPAID_ORDER_TTL_MINUTES) : 20,
  staleOrderCloseHours:
    Number(process.env.STALE_ORDER_CLOSE_HOURS) > 0 ? Number(process.env.STALE_ORDER_CLOSE_HOURS) : 12,
  lateOrderRequestTtlMinutes:
    Number(process.env.LATE_ORDER_REQUEST_TTL_MINUTES) > 0
      ? Number(process.env.LATE_ORDER_REQUEST_TTL_MINUTES)
      : Number(process.env.UNPAID_ORDER_TTL_MINUTES) > 0
        ? Number(process.env.UNPAID_ORDER_TTL_MINUTES)
        : 20,
  deliveryNoticeChatRef: process.env.DELIVERY_NOTICE_CHAT_REF?.trim() || 'delivery-group',
  aiTestPhones: parseAiTestPhones(process.env.AI_TEST_PHONES),
  bootstrapAdmin: {
    username: process.env.BOOTSTRAP_ADMIN_USERNAME?.trim() || 'admin',
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
  },
});
