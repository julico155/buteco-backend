import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OrderChannel, OrderDeliveryType, OrderPaymentMethod, QrScope } from '../../database/types';
import { DeliveryLocationDto } from './delivery-location.dto';
import { OrderItemInputDto } from './order-item-input.dto';
import { OrderPromotionInputDto } from './order-promotion-input.dto';

const CHANNELS: OrderChannel[] = ['whatsapp', 'web', 'pos', 'external'];
const DELIVERY_TYPES: OrderDeliveryType[] = ['delivery', 'pickup', 'dine_in'];
const PAYMENT_METHODS: OrderPaymentMethod[] = ['qr', 'cash'];
const QR_SCOPES: QrScope[] = ['food_only', 'food_and_delivery'];

export class CreateOrderDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  /**
   * Opcional en el body: el canal real se deriva de la credencial
   * (`resolveOrderChannel`, en el controller) y, si se manda, tiene que
   * coincidir. Tras el controller siempre viene seteado.
   */
  @IsOptional()
  @IsIn(CHANNELS)
  channel!: OrderChannel;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  customerName!: string;

  @IsIn(DELIVERY_TYPES)
  deliveryType!: OrderDeliveryType;

  @IsIn(PAYMENT_METHODS)
  paymentMethod!: OrderPaymentMethod;

  /**
   * Solo delivery + QR: `food_only` (el repartidor cobra el envío) o
   * `food_and_delivery` (el QR cubre todo). Omitido, se usa la única variante
   * habilitada o, si hay dos, `food_only`. Ver GET /payment-options.
   */
  @IsOptional()
  @IsIn(QR_SCOPES)
  qrScope?: QrScope;

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

  /**
   * OPCIONAL. Ubicación elegida en el checkout web, para que el pedido nazca ya cotizado y no se le vuelva a pedir el
   * pin por WhatsApp. Solo la admiten los servicios autorizados `web` y `whatsapp-gateway` (esta última es la credencial de servidor
   * compartida por el menú y el agente; el pedido conserva el canal `whatsapp`) y solo con `deliveryType='delivery'` (si no, 400
   * `delivery_location_not_supported` / `validation_error`). Sin ella, todo funciona como siempre. Ningún importe de
   * delivery viaja aquí: Central cotiza con su propio cálculo y el subtotal real del pedido.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => DeliveryLocationDto)
  deliveryLocation?: DeliveryLocationDto;

  /**
   * Solo un pedido de mesa (`dine_in`) del POS: la reserva cuyo adelanto se descuenta como crédito a favor. El pedido nace con
   * el consumo neto del adelanto, y la reserva queda usada. 409 si la reserva no se puede usar (sin adelanto pagado, ya usada,
   * cancelada o vencida).
   */
  @IsOptional()
  @IsUUID()
  reservationId?: string;

  /** Solo honrado para staff con rol autorizado — ver módulo `auth` (pendiente). */
  @IsOptional()
  @IsBoolean()
  bypassHoursGate?: boolean;
}
