import { OrderDeliveryType, OrderPaymentMethod } from '../database/types';

/**
 * ¿Hay que exigir `payment_status = 'paid'` antes de cerrar el pedido
 * (entregado / despachado)?
 *
 * QR y split: siempre — no se entrega ni se despacha algo sin cobrar.
 * Efectivo: por defecto no (se cobra al final: el repartidor al entregar, el
 * mostrador al retirar). Con `cash_prepayment_required` el efectivo de
 * pickup/mesa tiene que estar cobrado antes de entregarlo; el de delivery
 * sigue siendo contra entrega aunque el flag esté prendido, porque lo cobra
 * el repartidor.
 */
export function requiresPaymentBeforeHandover(params: {
  paymentMethod: OrderPaymentMethod;
  deliveryType: OrderDeliveryType;
  cashPrepaymentRequired: boolean;
}): boolean {
  if (params.paymentMethod !== 'cash') return true;
  return params.cashPrepaymentRequired && params.deliveryType !== 'delivery';
}
