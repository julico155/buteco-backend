import { ApiProperty } from '@nestjs/swagger';

export class OperationalSettingsResponse {
  rainSurchargeEnabled!: boolean;
  rainSurchargeAmount!: number;
  /** Margen ancho de cordura, no el horario preciso. */
  businessOpensHour!: number;
  businessClosesHour!: number;
  restaurantLatitude!: number | null;
  restaurantLongitude!: number | null;
  /** Tipos de servicio y canales que el local toma; solo afecta a pedidos nuevos. */
  serviceDeliveryEnabled!: boolean;
  servicePickupEnabled!: boolean;
  serviceDineInEnabled!: boolean;
  channelPosEnabled!: boolean;
  channelWhatsappEnabled!: boolean;
  channelWebEnabled!: boolean;
  channelExternalEnabled!: boolean;
  /** Pedido mínimo por tipo de servicio, sobre el subtotal. 0 = sin mínimo. */
  minOrderDelivery!: number;
  minOrderPickup!: number;
  minOrderDineIn!: number;
  @ApiProperty({ enum: ['bands', 'fixed', 'free'] })
  deliveryPricingMode!: 'bands' | 'fixed' | 'free';
  deliveryFixedFee!: number | null;
  deliveryFreeOverAmount!: number | null;
  deliveryMaxDistanceMeters!: number | null;
  requireOpenRegister!: boolean;
  @ApiProperty({ enum: ['queue', 'reject', 'accept'] })
  outOfHoursPolicy!: 'queue' | 'reject' | 'accept';
  /** Tope del monto que el staff puede fijar en una cotización de delivery manual. */
  manualQuoteMaxAmount!: number;
  /** El efectivo de pickup/mesa exige pago confirmado antes de entregarse. */
  cashPrepaymentRequired!: boolean;
  /** Días que abre el local: domingo = 0 … sábado = 6. */
  openWeekdays!: number[];
  /** Hora límite (HH:MM) para aceptar pedidos de delivery; null = sin tope propio. */
  deliveryLastOrderTime!: string | null;
  /** Hora límite (HH:MM) para aceptar pedidos de recojo; null = sin tope propio. */
  pickupLastOrderTime!: string | null;
}
