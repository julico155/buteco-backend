import { ApiProperty } from '@nestjs/swagger';
import {
  DELIVERY_QUOTE_STATUS_VALUES,
  ORDER_CHANNEL_VALUES,
  ORDER_DELIVERY_TYPE_VALUES,
  ORDER_PAYMENT_METHOD_VALUES,
  ORDER_PAYMENT_STATUS_VALUES,
  ORDER_STATUS_VALUES,
  QR_SCOPE_VALUES,
} from '../../common/api-enums';
import { QrScope } from '../../database/types';

/**
 * Formas de las respuestas de pedidos. Son clases (no interfaces) para que el
 * generador de OpenAPI las lea: con interfaces cada endpoint salía documentado
 * como un objeto vacío y los clientes (POS, landing, agente) no recibían los
 * campos al generar sus tipos.
 */

/** Un componente de combo tal como se vendió (copia del momento de la venta). */
export class PromotionComponentResponse {
  productId!: string;
  code!: string;
  name!: string;
  unitPrice!: number;
  quantity!: number;
}

/** Una opción elegida tal como la ve el cliente en el pedido (sin banderas internas). */
export class OrderItemSelectedOptionResponse {
  groupId!: string;
  optionId!: string;
  groupCode!: string;
  groupName!: string;
  optionCode!: string;
  optionName!: string;
  priceDelta!: number;
}

export class OrderItemResponse {
  productId!: string;
  productCodeSnapshot!: string;
  productNameSnapshot!: string;
  /** Precio unitario efectivo: base del producto + Σ priceDelta de las opciones elegidas. */
  unitPriceSnapshot!: number;
  quantity!: number;
  subtotal!: number;
  excludedComplements!: string[];
  /** Solo cuando la línea tiene opciones elegidas; los productos sin grupos no llevan la clave. */
  selectedOptions?: OrderItemSelectedOptionResponse[];
  /** Ronda de la cuenta de mesa en la que se agregó (1 en pedidos normales). */
  roundNumber!: number;
}

export class OrderPromotionResponse {
  promotionId!: string | null;
  promotionNameSnapshot!: string;
  promoPriceSnapshot!: number;
  comboQuantity!: number;
  subtotal!: number;
  componentsSnapshot!: PromotionComponentResponse[];
  roundNumber!: number;
}

export class OrderResponse {
  id!: string;
  orderNumber!: string;
  customerId!: string | null;
  @ApiProperty({ enum: ORDER_CHANNEL_VALUES })
  channel!: string;
  customerName!: string;
  @ApiProperty({ enum: ORDER_DELIVERY_TYPE_VALUES })
  deliveryType!: string;
  /** Mesa de la cuenta (solo dine_in abierto desde una mesa). */
  tableId!: string | null;
  /** "Pidió la cuenta" (cuenta de mesa). */
  billRequestedAt!: string | null;
  @ApiProperty({ enum: ORDER_PAYMENT_METHOD_VALUES })
  paymentMethod!: string;
  /** Solo delivery pagado por QR: 'food_only' (el repartidor cobra el envío) o 'food_and_delivery' (el QR cubre todo). */
  @ApiProperty({ enum: QR_SCOPE_VALUES, nullable: true })
  qrScope!: QrScope | null;
  @ApiProperty({ enum: ORDER_PAYMENT_STATUS_VALUES })
  paymentStatus!: string;
  @ApiProperty({ enum: ORDER_STATUS_VALUES })
  status!: string;
  notes!: string | null;
  subtotalAmount!: number;
  deliveryBaseAmount!: number;
  deliverySurchargeAmount!: number;
  totalAmount!: number;
  @ApiProperty({ enum: DELIVERY_QUOTE_STATUS_VALUES, nullable: true })
  deliveryQuoteStatus!: string | null;
  deliveryDistanceMeters!: number | null;
  cashConfirmedAt!: string | null;
  /** Solo con paymentMethod='split'. */
  splitCashAmount!: number | null;
  splitQrAmount!: number | null;
  splitCashConfirmedAt!: string | null;
  statusUpdatedBy!: string | null;
  /** Repartidor asignado (solo pedidos de delivery ya aceptados). */
  deliveryDriverName!: string | null;
  deliveryAcceptedAt!: string | null;
  deliveredAt!: string | null;
  createdAt!: string;
  /**
   * Última escritura de la fila, no solo cambios de status — también se toca al agregar una nota, adjuntar ubicación o
   * armar un split.
   */
  updatedAt!: string;
  items!: OrderItemResponse[];
  /** Combos vendidos. `items` solo trae los productos sueltos, así que sin esto el ticket queda incompleto. */
  promotions!: OrderPromotionResponse[];
}
