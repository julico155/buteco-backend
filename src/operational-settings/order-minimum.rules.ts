import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';
import { OrderDeliveryType } from '../database/types';

export type OrderMinimums = Record<OrderDeliveryType, number>;

/** Subconjunto de `operational_settings` con los mínimos (numeric llega como string). */
export interface MinimumsRow {
  min_order_delivery: string;
  min_order_pickup: string;
  min_order_dine_in: string;
}

export function minimumsFrom(row: Partial<MinimumsRow>): OrderMinimums {
  return {
    delivery: Number(row.min_order_delivery ?? 0),
    pickup: Number(row.min_order_pickup ?? 0),
    dine_in: Number(row.min_order_dine_in ?? 0),
  };
}

/**
 * El pedido mínimo se compara contra el subtotal (la comida): el envío no
 * cuenta para llegar al mínimo. 0 = sin mínimo.
 */
export function assertMinimumOrder(
  minimums: OrderMinimums,
  serviceType: OrderDeliveryType,
  subtotal: number,
): void {
  const minimum = minimums[serviceType];
  // Redondeo a centavos: 29.999999 no debe dejar afuera a un mínimo de 30.
  if (minimum <= 0 || Math.round(subtotal * 100) >= Math.round(minimum * 100)) return;
  throw new DomainException(
    'below_minimum_order',
    HttpStatus.BAD_REQUEST,
    `El pedido no llega al mínimo de ${minimum.toFixed(2)} para este tipo de servicio.`,
    { serviceType, minimumAmount: minimum, subtotalAmount: subtotal },
  );
}
