import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';
import { DashboardUserRole, OrderDeliveryType, OrderStatus } from '../database/types';
import { haversineMeters } from '../delivery/distance/distance.service';

export type PresenceCheck =
  | { ok: true }
  | { ok: false; code: 'not_at_restaurant' | 'location_too_imprecise' };

/**
 * ¿El repartidor está en el local? Un GPS impreciso (accuracy peor que el
 * radio) no sirve para decidir: la posición real podría estar en cualquier
 * lado dentro del círculo de error, así que se pide reintentar en vez de
 * aceptar o rechazar a ciegas.
 */
export function checkDriverPresence(
  distanceMeters: number,
  accuracyMeters: number | undefined,
  radiusMeters: number,
): PresenceCheck {
  if (accuracyMeters !== undefined && accuracyMeters > radiusMeters) {
    return { ok: false, code: 'location_too_imprecise' };
  }
  if (distanceMeters > radiusMeters) return { ok: false, code: 'not_at_restaurant' };
  return { ok: true };
}

export function presenceException(
  check: Extract<PresenceCheck, { ok: false }>,
  distanceMeters: number,
  radiusMeters: number,
): DomainException {
  if (check.code === 'location_too_imprecise') {
    return new DomainException(
      'location_too_imprecise',
      HttpStatus.BAD_REQUEST,
      'La ubicación del celular es muy imprecisa. Activá el GPS de alta precisión y reintentá.',
      { radiusMeters },
    );
  }
  return new DomainException(
    'not_at_restaurant',
    HttpStatus.FORBIDDEN,
    'Tenés que estar en el local para aceptar el pedido.',
    { distanceMeters, radiusMeters },
  );
}

/**
 * Un pedido de delivery solo entra en reparto por el flujo del repartidor
 * (aceptar en el local) — la cocina no puede saltárselo marcándolo
 * out_for_delivery/delivered a mano. El admin queda como override.
 */
export function assertRoleCanMoveStatus(
  role: DashboardUserRole,
  deliveryType: OrderDeliveryType,
  to: OrderStatus,
): void {
  if (
    deliveryType === 'delivery' &&
    (to === 'out_for_delivery' || to === 'delivered') &&
    role !== 'admin'
  ) {
    throw new DomainException(
      'delivery_flow_only',
      HttpStatus.FORBIDDEN,
      'Los pedidos de delivery los toma y entrega un repartidor desde su pantalla.',
      { to },
    );
  }
}

/**
 * Historial de entregas: el repartidor solo ve las suyas (pedir las de otro es
 * 403); admin y cajero pueden filtrar por un repartidor o, sin filtro, ver
 * todos (null) para cuadrar a fin de noche.
 */
export function resolveHistoryDriverId(
  actor: { sub: string; role: DashboardUserRole },
  requestedDriverId: string | undefined,
): string | null {
  if (actor.role === 'delivery') {
    if (requestedDriverId && requestedDriverId !== actor.sub) {
      throw new DomainException(
        'not_your_history',
        HttpStatus.FORBIDDEN,
        'Solo podés ver tus propias entregas.',
      );
    }
    return actor.sub;
  }
  return requestedDriverId ?? null;
}

export function mapsUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}

export interface OrderLocation {
  id: string;
  orderNumber: string;
  latitude: number;
  longitude: number;
}

export interface NearbyOrder {
  id: string;
  orderNumber: string;
  distanceMeters: number;
}

/**
 * Para "disponibles" (antes de aceptar) nunca se manda lat/lng cruda — es una
 * decisión de privacidad explícita, el cliente no eligió que un repartidor al
 * que todavía no le tocó el pedido vea su domicilio exacto. Pero el
 * repartidor sí necesita poder detectar dos pedidos cercanos para llevárselos
 * en un solo viaje, así que esto da SOLO la distancia entre pedidos
 * disponibles entre sí (nunca respecto al local ni una coordenada), y solo
 * para los que caen dentro de `radiusMeters`. Un pedido sin coordenadas
 * (cotización todavía pendiente) queda sin entrada en el resultado.
 */
export function groupNearbyOrders(
  orders: OrderLocation[],
  radiusMeters: number,
): Map<string, NearbyOrder[]> {
  const result = new Map<string, NearbyOrder[]>();
  for (const order of orders) result.set(order.id, []);

  for (let i = 0; i < orders.length; i++) {
    for (let j = i + 1; j < orders.length; j++) {
      const a = orders[i];
      const b = orders[j];
      const distanceMeters = haversineMeters(a, b);
      if (distanceMeters > radiusMeters) continue;
      result.get(a.id)!.push({ id: b.id, orderNumber: b.orderNumber, distanceMeters });
      result.get(b.id)!.push({ id: a.id, orderNumber: a.orderNumber, distanceMeters });
    }
  }
  for (const list of result.values()) list.sort((x, y) => x.distanceMeters - y.distanceMeters);
  return result;
}
