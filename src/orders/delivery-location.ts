import { HttpStatus } from '@nestjs/common';
import { DomainException, ValidationError } from '../common/exceptions/domain-exception';
import { OrderChannel, OrderDeliveryType } from '../database/types';

/** Coordenadas de entrega tal como las manda el checkout web al crear el pedido. */
export interface DeliveryLocationInput {
  latitude: number;
  longitude: number;
}

/**
 * Servicios (api_client autenticados) que pueden mandar una ubicación AL CREAR un pedido, y el canal que cada uno produce.
 * La autorización la decide la IDENTIDAD del servicio autenticado (el token de `SERVICE_AUTH_TOKENS`), nunca un campo del
 * body ni el canal por sí solo:
 *   - `web`: la credencial del canal web (restricciones de siempre);
 *   - `whatsapp-gateway`: credencial de SERVIDOR compartida por el agente y por el menú web (`BACKEND_CENTRAL_SERVICE_TOKEN`).
 *     Autoriza al servicio, no exclusivamente al checkout web; el pedido sigue siendo canal `whatsapp`. Nunca llega al navegador.
 * Cualquier otro api_client (POS/JWT de staff, `external`, uno nuevo que mapee a `whatsapp`) NO queda autorizado: hay que
 * agregarlo aquí a propósito.
 */
const DELIVERY_LOCATION_PRINCIPALS: Readonly<Record<string, OrderChannel>> = {
  web: 'web',
  'whatsapp-gateway': 'whatsapp',
};

/** `true` solo si ESE servicio autenticado, con el canal que sale de su credencial, puede mandar `deliveryLocation`. */
export function canSendDeliveryLocation(apiClient: string | undefined, channel: OrderChannel): boolean {
  return apiClient !== undefined && Object.prototype.hasOwnProperty.call(DELIVERY_LOCATION_PRINCIPALS, apiClient) && DELIVERY_LOCATION_PRINCIPALS[apiClient] === channel;
}

/**
 * Regla única de quién puede mandar una ubicación AL CREAR un pedido (checkout web). Se evalúa con el api_client autenticado
 * y el canal que sale de esa misma CREDENCIAL (`resolveOrderChannel`), nunca con un campo que declare el navegador:
 *   - solo los servicios de `DELIVERY_LOCATION_PRINCIPALS` (`web` y `whatsapp-gateway`); POS y `external` siguen con su flujo
 *     de siempre y, si la mandan, se rechaza en vez de ignorarla en silencio;
 *   - solo `delivery`: pickup y mesa no tienen ubicación;
 *   - coordenadas numéricas, finitas y dentro de rango (el DTO ya lo exige; esto es la última defensa de quien cree el pedido).
 * Devuelve la ubicación normalizada, o `null` si no vino ninguna (los clientes anteriores siguen igual). Los errores nunca
 * llevan las coordenadas.
 */
export function assertWebDeliveryLocation(params: {
  apiClient: string | undefined;
  channel: OrderChannel;
  deliveryType: OrderDeliveryType;
  location: DeliveryLocationInput | null | undefined;
}): DeliveryLocationInput | null {
  const { location } = params;
  if (location === null || location === undefined) return null;

  if (!canSendDeliveryLocation(params.apiClient, params.channel)) {
    throw notSupported(params.channel);
  }
  return normalizeDeliveryLocation(params.deliveryType, location);
}

/**
 * Defensa en profundidad de `createOrderInTransaction`, el único punto que escribe. Allí ya no se conoce al servicio (una
 * solicitud tardía se acepta mucho después, con el JWT de staff), así que solo se exige lo que el servicio autorizado ya
 * dejó establecido: un canal que tiene algún servicio autorizado (`web` / `whatsapp`; nunca `pos` ni `external`), delivery y
 * coordenadas válidas. La autorización por servicio ocurre en los puntos de entrada (`create`, reemplazos) con `assertWebDeliveryLocation`.
 */
export function assertDeliveryLocationForWrite(params: {
  channel: OrderChannel;
  deliveryType: OrderDeliveryType;
  location: DeliveryLocationInput | null | undefined;
}): DeliveryLocationInput | null {
  const { location } = params;
  if (location === null || location === undefined) return null;
  if (!Object.values(DELIVERY_LOCATION_PRINCIPALS).includes(params.channel)) throw notSupported(params.channel);
  return normalizeDeliveryLocation(params.deliveryType, location);
}

function notSupported(channel: OrderChannel): DomainException {
  return new DomainException(
    'delivery_location_not_supported',
    HttpStatus.BAD_REQUEST,
    'Esta credencial no puede mandar la ubicación al crear el pedido.',
    { channel },
  );
}

function normalizeDeliveryLocation(deliveryType: OrderDeliveryType, location: DeliveryLocationInput): DeliveryLocationInput {
  if (deliveryType !== 'delivery') {
    throw new ValidationError('deliveryLocation solo aplica a pedidos de delivery.');
  }
  if (!isCoordinate(location.latitude, 90) || !isCoordinate(location.longitude, 180)) {
    throw new ValidationError('deliveryLocation no es una ubicación válida.');
  }
  return { latitude: location.latitude, longitude: location.longitude };
}

/**
 * Igualdad EXACTA (no la tolerancia de 5 m de `decideLocationAttach`): sirve para decidir si un reintento con la misma
 * `Idempotency-Key` trae la misma ubicación que la solicitud ya guardada. Un reintento real manda los mismos números.
 */
export function sameDeliveryLocation(a: DeliveryLocationInput | null, b: DeliveryLocationInput | null): boolean {
  if (a === null || b === null) return a === b;
  return a.latitude === b.latitude && a.longitude === b.longitude;
}

/**
 * Cuerpo que entra al hash de idempotencia. La ubicación solo forma parte de él cuando VIENE: si no, se quita la clave (el DTO
 * la trae como `undefined` y `canonicalize` la escribiría como `"deliveryLocation":undefined`). Así el hash de un pedido sin
 * ubicación es exactamente el de siempre, y un reintento enviado antes de esta extensión no choca con `idempotency_key_reused`.
 */
export function idempotencyBody<T extends object>(dto: T): T | Omit<T, 'deliveryLocation'> {
  const location = (dto as { deliveryLocation?: unknown }).deliveryLocation;
  const body =
    location !== undefined && location !== null
      ? dto
      : (Object.fromEntries(Object.entries(dto).filter(([key]) => key !== 'deliveryLocation')) as Omit<T, 'deliveryLocation'>);
  return withoutUnsetItemSelections(body);
}

/**
 * Mismo criterio para `items[].selectedOptions` (opciones de producto): solo entra al hash cuando VIENE. Sin esto el DTO la trae
 * como `undefined` en cada ítem y el hash de TODO pedido cambiaría con este despliegue: un reintento de un pedido enviado antes
 * recibiría 409 `idempotency_key_reused`.
 */
function withoutUnsetItemSelections<T extends object>(body: T): T {
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return body;
  const isUnset = (item: unknown): boolean =>
    typeof item === 'object' && item !== null && 'selectedOptions' in item && (item as { selectedOptions?: unknown }).selectedOptions == null;
  if (!items.some(isUnset)) return body;
  return {
    ...body,
    items: items.map((item) =>
      isUnset(item) ? Object.fromEntries(Object.entries(item as object).filter(([key]) => key !== 'selectedOptions')) : item,
    ),
  };
}

function isCoordinate(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -limit && value <= limit;
}
