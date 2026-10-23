import { ApiProperty } from '@nestjs/swagger';
import {
  ORDER_CHANNEL_VALUES,
  ORDER_DELIVERY_TYPE_VALUES,
  ORDER_PAYMENT_METHOD_VALUES,
  QR_SCOPE_VALUES,
} from '../../common/api-enums';
import { OrderChannel, OrderDeliveryType, OrderPaymentMethod, QrScope } from '../../database/types';

export class PaymentOptionResponse {
  @ApiProperty({ enum: ORDER_DELIVERY_TYPE_VALUES })
  serviceType!: OrderDeliveryType;
  @ApiProperty({ enum: ORDER_PAYMENT_METHOD_VALUES })
  paymentMethod!: OrderPaymentMethod;
  /** Solo delivery pagado por QR; null en el resto. */
  @ApiProperty({ enum: QR_SCOPE_VALUES, nullable: true })
  qrScope!: QrScope | null;
  /** Lo que prendió el admin. */
  enabled!: boolean;
  /** Canales de origen que pueden usar esta forma de pago. */
  @ApiProperty({ enum: ORDER_CHANNEL_VALUES, isArray: true })
  channels!: OrderChannel[];
  /**
   * Lo que el frontend debería ofrecer: prendida, permitida para el canal de quien consulta y con el banco listo si hace
   * falta. Pintar solo las `available`.
   */
  available!: boolean;
}
