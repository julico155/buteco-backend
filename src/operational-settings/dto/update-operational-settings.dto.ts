import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class UpdateOperationalSettingsDto {
  @IsOptional()
  @IsBoolean()
  rainSurchargeEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  rainSurchargeAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  businessOpensHour?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  businessClosesHour?: number;

  @IsOptional()
  @IsLatitude()
  restaurantLatitude?: number;

  @IsOptional()
  @IsLongitude()
  restaurantLongitude?: number;

  @IsOptional()
  @IsBoolean()
  serviceDeliveryEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  servicePickupEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  serviceDineInEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  channelPosEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  channelWhatsappEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  channelWebEnabled?: boolean;

  /** Canal `external`: POS ajeno que reporta ventas ya cobradas. Apagado por defecto. */
  @IsOptional()
  @IsBoolean()
  channelExternalEnabled?: boolean;

  /** Pedido mínimo (sobre el subtotal, sin envío). 0 = sin mínimo. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minOrderDelivery?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minOrderPickup?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minOrderDineIn?: number;

  @IsOptional()
  @IsIn(['bands', 'fixed', 'free'])
  deliveryPricingMode?: 'bands' | 'fixed' | 'free';

  /** Obligatorio con deliveryPricingMode='fixed'. null lo borra. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  deliveryFixedFee?: number | null;

  /** Envío gratis desde este subtotal. null lo desactiva. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  deliveryFreeOverAmount?: number | null;

  /** Techo de reparto automático (m); más allá se cotiza a mano. null = el que dé la tarifa. */
  @IsOptional()
  @IsInt()
  @Min(1)
  deliveryMaxDistanceMeters?: number | null;

  /** false: se puede cobrar sin caja abierta (y el gate de horario no la mira). */
  @IsOptional()
  @IsBoolean()
  requireOpenRegister?: boolean;

  /** Pedido dentro del margen horario pero sin caja: encolar, rechazar o aceptar. */
  @IsOptional()
  @IsIn(['queue', 'reject', 'accept'])
  outOfHoursPolicy?: 'queue' | 'reject' | 'accept';

  /** Tope del monto de una cotización de delivery manual (> 0). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  manualQuoteMaxAmount?: number;

  /** true: el efectivo de pickup/mesa se cobra antes de cocinar. El de delivery no cambia. */
  @IsOptional()
  @IsBoolean()
  cashPrepaymentRequired?: boolean;

  /** Días que abre el local: domingo = 0 … sábado = 6. Vacío no vale: el local tiene que abrir algún día. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  openWeekdays?: number[];

  /** Hora límite (HH:MM) para aceptar pedidos de delivery. null = sin tope propio. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(CLOCK_TIME, { message: 'deliveryLastOrderTime debe tener formato HH:MM' })
  deliveryLastOrderTime?: string | null;

  /** Hora límite (HH:MM) para aceptar pedidos de recojo. null = sin tope propio. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(CLOCK_TIME, { message: 'pickupLastOrderTime debe tener formato HH:MM' })
  pickupLastOrderTime?: string | null;
}
