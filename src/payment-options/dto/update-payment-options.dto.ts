import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { OrderChannel, OrderDeliveryType, OrderPaymentMethod, QrScope } from '../../database/types';

const SERVICE_TYPES: OrderDeliveryType[] = ['delivery', 'pickup', 'dine_in'];
const PAYMENT_METHODS: OrderPaymentMethod[] = ['qr', 'cash', 'split'];
const QR_SCOPES: QrScope[] = ['food_only', 'food_and_delivery'];
const CHANNELS: OrderChannel[] = ['pos', 'whatsapp', 'web'];

export class PaymentOptionChangeDto {
  @IsIn(SERVICE_TYPES)
  serviceType!: OrderDeliveryType;

  @IsIn(PAYMENT_METHODS)
  paymentMethod!: OrderPaymentMethod;

  /** Obligatorio solo para delivery + qr; ausente (o null) en el resto. */
  @IsOptional()
  @IsIn(QR_SCOPES)
  qrScope?: QrScope | null;

  /** Prender/apagar la forma de pago. Opcional si se manda `channels`. */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** Canales de origen que pueden usarla (reemplaza la lista completa). Opcional si se manda `enabled`. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(CHANNELS, { each: true })
  channels?: OrderChannel[];
}

export class UpdatePaymentOptionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PaymentOptionChangeDto)
  options!: PaymentOptionChangeDto[];
}
