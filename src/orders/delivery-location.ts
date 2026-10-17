import { HttpStatus } from '@nestjs/common';
import { DomainException, ValidationError } from '../common/exceptions/domain-exception';
import { OrderChannel, OrderDeliveryType } from '../database/types';

/** Coordenadas de entrega tal como las manda el checkout web al crear el pedido. */
export interface DeliveryLocationInput {
  latitude: number;
  longitude: number;
}

/**
 * Regla única de quién puede mandar una ubicación AL CREAR un pedido (checkout web). Se evalúa con el canal que sale de
 * la CREDENCIAL (`resolveOrderChannel`), nunca con un campo que declare el navegador:
 *   - solo el canal `web`: WhatsApp, POS y `external` siguen usando su flujo de siempre (ubicación por WhatsApp, o ninguna).
 *     Si alguno la manda, se rechaza en vez de ignorarla en silencio;
 *   - solo `delivery`: pickup y mesa no tienen ubicación;
 *   - coordenadas numéricas, finitas y dentro de rango (el DTO ya lo exige; esto es la última defensa de quien cree el pedido).
 * Devuelve la ubicación normalizada, o `null` si no vino ninguna (los clientes anteriores siguen igual). Los errores nunca
 * llevan las coordenadas.
 */
export function assertWebDeliveryLocation(params: {
  channel: OrderChannel;
  deliveryType: OrderDeliveryType;
  location: DeliveryLocationInput | null | undefined;
}): DeliveryLocationInput | null {
  const { location } = params;
  if (location === null || location === undefined) return null;

  if (params.channel !== 'web') {
    throw new DomainException(
      'delivery_location_not_supported',
      HttpStatus.BAD_REQUEST,
      'La ubicación al crear el pedido solo la admite el checkout web.',
      { channel: params.channel },
    );
  }
  if (params.deliveryType !== 'delivery') {
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
  if (location !== undefined && location !== null) return dto;
  return Object.fromEntries(Object.entries(dto).filter(([key]) => key !== 'deliveryLocation')) as Omit<T, 'deliveryLocation'>;
}

function isCoordinate(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -limit && value <= limit;
}
