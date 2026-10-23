import type { CustomerMessageComboItem, CustomerMessageOrderItem } from '../gateway-client/gateway-client.service';
import type { OrderItemResponse, OrderPromotionResponse, OrderResponse } from './orders.service';

export interface QrConfirmationContext {
  orderNumber: string;
  currency: 'BOB';
  deliveryType: 'delivery' | 'pickup' | 'dine_in';
  items: CustomerMessageOrderItem[];
  promotions: CustomerMessageComboItem[];
  subtotalAmount: number;
  deliveryBaseAmount: number;
  deliverySurchargeAmount: number;
  deliveryAmount: number;
  totalAmount: number;
  qrAmount: number;
  /** Qué cubre el QR: 'food_and_delivery' = comida + envío; null/'food_only' = solo comida. */
  qrScope: 'food_only' | 'food_and_delivery' | null;
}

/**
 * Lo que cobra el QR de un pedido: el total cuando el cliente eligió pagar
 * comida + envío por QR; si no, solo la comida (el envío, si es delivery, se
 * cobra en efectivo al repartidor). Misma regla que `qrChargeAmount`.
 */
export function qrAmountFor(
  order: Pick<OrderResponse, 'qrScope' | 'totalAmount' | 'subtotalAmount'>,
): number {
  return order.qrScope === 'food_and_delivery' ? order.totalAmount : order.subtotalAmount;
}

/** Central entrega el desglose completo; el agente arma el copy. */
export function buildQrConfirmationContext(order: OrderResponse): QrConfirmationContext {
  return {
    orderNumber: order.orderNumber,
    currency: 'BOB',
    deliveryType: order.deliveryType as 'delivery' | 'pickup' | 'dine_in',
    items: order.items.map(toOrderItem),
    promotions: order.promotions.map(toComboItem),
    subtotalAmount: order.subtotalAmount,
    deliveryBaseAmount: order.deliveryBaseAmount,
    deliverySurchargeAmount: order.deliverySurchargeAmount,
    deliveryAmount: order.deliveryBaseAmount + order.deliverySurchargeAmount,
    totalAmount: order.totalAmount,
    qrAmount: qrAmountFor(order),
    qrScope: order.qrScope,
  };
}

function toOrderItem(item: OrderItemResponse): CustomerMessageOrderItem {
  return {
    name: item.productNameSnapshot,
    quantity: item.quantity,
    unitPrice: item.unitPriceSnapshot,
    subtotal: item.subtotal,
    excludedComplements: item.excludedComplements,
    ...(item.selectedOptions && item.selectedOptions.length > 0
      ? {
          selectedOptions: item.selectedOptions.map((option) => ({
            groupName: option.groupName,
            optionName: option.optionName,
            priceDelta: option.priceDelta,
          })),
        }
      : {}),
  };
}

function toComboItem(promotion: OrderPromotionResponse): CustomerMessageComboItem {
  return {
    name: promotion.promotionNameSnapshot,
    quantity: promotion.comboQuantity,
    unitPrice: promotion.promoPriceSnapshot,
    subtotal: promotion.subtotal,
    components: promotion.componentsSnapshot.map((component) => ({
      name: component.name,
      quantity: component.quantity,
    })),
  };
}
