import { haversineMeters } from '../delivery/distance/distance.service';

/** Dos ubicaciones a menos de esto son "la misma" (el GPS del celular no repite coordenadas exactas). */
export const SAME_LOCATION_TOLERANCE_METERS = 5;

export type LocationAttachDecision =
  | 'attach' // sin ubicación todavía (o misma ubicación sin cotizar): guardar y cotizar
  | 'replace' // ubicación distinta pero aún sin cotización aplicada: se reemplaza y se cotiza
  | 'already_attached' // misma ubicación otra vez: no hay nada que hacer
  | 'conflict' // ubicación distinta con el pedido ya cotizado/avanzado: NO se toca nada
  | 'not_awaiting'; // el pedido no está esperando ubicación y no tiene ninguna

export interface LocationAttachOrderState {
  status: string;
  delivery_quote_status: string | null;
  delivery_latitude: number | null;
  delivery_longitude: number | null;
}

/**
 * Regla única para adjuntar una ubicación a un pedido de delivery, compartida
 * por `POST /orders/:id/location` y `POST /internal/agent/locations/attach`.
 * Nunca puede quedar una tarifa calculada con la ubicación A y coordenadas B
 * guardadas: una vez cotizada (o pending_manual, o el pedido avanzó), otra
 * ubicación distinta es conflicto y no se escribe.
 */
export function decideLocationAttach(
  order: LocationAttachOrderState,
  incoming: { latitude: number; longitude: number },
  toleranceMeters: number = SAME_LOCATION_TOLERANCE_METERS,
): LocationAttachDecision {
  const awaiting = order.status === 'awaiting_location';
  const unquoted =
    order.delivery_quote_status === 'pending' || order.delivery_quote_status === 'failed';

  if (order.delivery_latitude === null || order.delivery_longitude === null) {
    return awaiting ? 'attach' : 'not_awaiting';
  }

  const same =
    haversineMeters(
      { latitude: order.delivery_latitude, longitude: order.delivery_longitude },
      incoming,
    ) <= toleranceMeters;

  if (same) return awaiting && unquoted ? 'attach' : 'already_attached';
  return awaiting && unquoted ? 'replace' : 'conflict';
}
