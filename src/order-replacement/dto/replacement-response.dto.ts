import { ApiProperty } from '@nestjs/swagger';
import { ORDER_DELIVERY_TYPE_VALUES, ORDER_PAYMENT_METHOD_VALUES, ORDER_STATUS_VALUES } from '../../common/api-enums';
import { OrderDeliveryType, OrderPaymentMethod, OrderStatus } from '../../database/types';

/**
 * Respuestas de los endpoints del agente para reemplazar un pedido. Los
 * desenlaces esperados (no hay pedido, no se puede reemplazar, etc.) vuelven con
 * `result`; se discriminan por ese campo.
 */

export const REPLACEABLE_REASON_CODE_VALUES = [
  'already_paid',
  'payment_in_progress',
  'payment_status_not_unpaid',
  'operational',
] as const;
export type ReplaceableReasonCodeValue = (typeof REPLACEABLE_REASON_CODE_VALUES)[number];

/** Solo ids (no precios ni nombres): es exactamente lo que el cliente reenvía a `replacements`. */
export class ReplaceableCartSelectedOption {
  groupId!: string;
  optionId!: string;
}

export class ReplaceableCartItem {
  productId!: string;
  quantity!: number;
  excludedComplements!: string[];
  /** Solo si la línea tiene opciones elegidas. */
  selectedOptions?: ReplaceableCartSelectedOption[];
}

export class ReplaceableCartPromotion {
  promotionId!: string;
  quantity!: number;
}

export class ReplaceableCart {
  @ApiProperty({ enum: ORDER_DELIVERY_TYPE_VALUES })
  deliveryType!: OrderDeliveryType;
  items!: ReplaceableCartItem[];
  promotions!: ReplaceableCartPromotion[];
}

export class ReplaceableNoOrder {
  @ApiProperty({ enum: ['no_order'] })
  result!: 'no_order';
}

export class ReplaceableNotReplaceable {
  @ApiProperty({ enum: ['not_replaceable'] })
  result!: 'not_replaceable';
  @ApiProperty({ enum: REPLACEABLE_REASON_CODE_VALUES })
  reasonCode!: ReplaceableReasonCodeValue;
}

export class ReplaceableOrderFound {
  @ApiProperty({ enum: ['replaceable'] })
  result!: 'replaceable';
  orderId!: string;
  orderNumber!: string;
  @ApiProperty({ enum: ORDER_STATUS_VALUES })
  status!: OrderStatus;
  @ApiProperty({ enum: ORDER_DELIVERY_TYPE_VALUES })
  deliveryType!: OrderDeliveryType;
  @ApiProperty({ enum: ORDER_PAYMENT_METHOD_VALUES })
  paymentMethod!: OrderPaymentMethod;
  hasLocation!: boolean;
  cart!: ReplaceableCart;
}

export type ReplaceableOrderResult = ReplaceableNoOrder | ReplaceableNotReplaceable | ReplaceableOrderFound;

export class AppendNoteSaved {
  @ApiProperty({ enum: ['saved'] })
  result!: 'saved';
}

export class AppendNoteNoOrder {
  @ApiProperty({ enum: ['no_order'] })
  result!: 'no_order';
}

export class AppendNoteNotAllowed {
  @ApiProperty({ enum: ['not_allowed'] })
  result!: 'not_allowed';
  @ApiProperty({ enum: REPLACEABLE_REASON_CODE_VALUES })
  reasonCode!: ReplaceableReasonCodeValue;
}

export type AppendNoteResult = AppendNoteSaved | AppendNoteNoOrder | AppendNoteNotAllowed;

export class ReplacementDone {
  @ApiProperty({ enum: ['replaced'] })
  result!: 'replaced';
  orderId!: string;
  orderNumber!: string;
  replacedOrderId!: string;
}

export class ReplacementNotFound {
  @ApiProperty({ enum: ['not_found'] })
  result!: 'not_found';
}

/** dto.orderId no es el último pedido activo de WhatsApp del cliente — la sesión/CTA quedó vieja. */
export class ReplacementStaleOrder {
  @ApiProperty({ enum: ['stale_order'] })
  result!: 'stale_order';
  currentOrderId!: string;
}

export class ReplacementNotReplaceable {
  @ApiProperty({ enum: ['not_replaceable'] })
  result!: 'not_replaceable';
  @ApiProperty({ enum: REPLACEABLE_REASON_CODE_VALUES })
  reasonCode!: ReplaceableReasonCodeValue;
}

export type CreateReplacementResult =
  | ReplacementDone
  | ReplacementNotFound
  | ReplacementStaleOrder
  | ReplacementNotReplaceable;
