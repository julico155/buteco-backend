import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OrderDeliveryType, OrderPaymentMethod, QrScope } from '../../database/types';
import { OrderItemInputDto } from '../../orders/dto/order-item-input.dto';
import { OrderPromotionInputDto } from '../../orders/dto/order-promotion-input.dto';

const DELIVERY_TYPES: OrderDeliveryType[] = ['delivery', 'pickup', 'dine_in'];
const PAYMENT_METHODS: OrderPaymentMethod[] = ['qr', 'cash'];
const QR_SCOPES: QrScope[] = ['food_only', 'food_and_delivery'];

export class CreateOrderReplacementDto {
  /** wa_id / teléfono tal como llega de WhatsApp; Central lo normaliza y resuelve el cliente. */
  @IsString()
  @MinLength(6)
  @MaxLength(32)
  customerPhone!: string;

  /**
   * El pedido a reemplazar — el que devolvió GET .../replaceable. Nunca se
   * confía en esto por sí solo: se revalida ownership (pertenece al cliente
   * resuelto por customerPhone) y el predicado replaceable completo, de
   * nuevo, dentro de la misma transacción.
   */
  @IsUUID()
  orderId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  customerName!: string;

  @IsIn(DELIVERY_TYPES)
  deliveryType!: OrderDeliveryType;

  @IsIn(PAYMENT_METHODS)
  paymentMethod!: OrderPaymentMethod;

  /** Solo delivery + QR; ver CreateOrderDto.qrScope. */
  @IsOptional()
  @IsIn(QR_SCOPES)
  qrScope?: QrScope;

  /** Nunca se hereda del pedido viejo (podría referirse a algo que ya no está en el carrito) — opcional, nuevo. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderPromotionInputDto)
  promotions?: OrderPromotionInputDto[];
}
