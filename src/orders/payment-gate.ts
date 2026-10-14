import { OrderDeliveryType, OrderPaymentMethod } from '../database/types';

/**
 * ¿Hay que exigir `payment_status = 'paid'` antes de pasar a `preparing`?
 *
 * QR y split: siempre — el pago se confirma ANTES de que cocina empiece.
 * Efectivo: por defecto no (se cobra al final: el repartidor al entregar, el
 * mostrador al retirar). Con `cash_prepayment_required` el efectivo de
 * pickup/mesa también se cobra antes de cocinar; el de delivery sigue siendo
 * contra entrega aunque el flag esté prendido, porque lo cobra el repartidor.
 */
export function requiresPaymentBeforePreparing(params: {
  paymentMethod: OrderPaymentMethod;
  deliveryType: OrderDeliveryType;
  cashPrepaymentRequired: boolean;
}): boolean {
  if (params.paymentMethod !== 'cash') return true;
  return params.cashPrepaymentRequired && params.deliveryType !== 'delivery';
}
