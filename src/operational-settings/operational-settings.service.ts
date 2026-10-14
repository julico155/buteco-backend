import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { ValidationError } from '../common/exceptions/domain-exception';
import { UpdateOperationalSettingsDto } from './dto/update-operational-settings.dto';
import {
  assertAvailabilityConsistent,
  AvailabilityRow,
  channelAvailability,
  serviceAvailability,
} from './availability.rules';

export interface OperationalSettingsResponse {
  rainSurchargeEnabled: boolean;
  rainSurchargeAmount: number;
  /** Margen ancho de cordura, no el horario preciso — ver comentario en OperationalSettingsTable. */
  businessOpensHour: number;
  businessClosesHour: number;
  restaurantLatitude: number | null;
  restaurantLongitude: number | null;
  /** Tipos de servicio y canales que el local toma; solo afecta a pedidos nuevos. */
  serviceDeliveryEnabled: boolean;
  servicePickupEnabled: boolean;
  serviceDineInEnabled: boolean;
  channelPosEnabled: boolean;
  channelWhatsappEnabled: boolean;
  channelWebEnabled: boolean;
  channelExternalEnabled: boolean;
  /** Pedido mínimo por tipo de servicio, sobre el subtotal. 0 = sin mínimo. */
  minOrderDelivery: number;
  minOrderPickup: number;
  minOrderDineIn: number;
  deliveryPricingMode: 'bands' | 'fixed' | 'free';
  deliveryFixedFee: number | null;
  deliveryFreeOverAmount: number | null;
  deliveryMaxDistanceMeters: number | null;
  requireOpenRegister: boolean;
  outOfHoursPolicy: 'queue' | 'reject' | 'accept';
  /** Tope del monto que el staff puede fijar en una cotización de delivery manual. */
  manualQuoteMaxAmount: number;
  /** El efectivo de pickup/mesa exige pago confirmado antes de `preparing`. */
  cashPrepaymentRequired: boolean;
}

/**
 * Horario de atención + recargo por lluvia + coordenadas del restaurante —
 * fila única (id = true). El gate de horario (invariante 7), la medición de
 * distancia de delivery y la cotización (que congela el recargo en la misma
 * transacción) leen de aquí.
 */
@Injectable()
export class OperationalSettingsService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async get(): Promise<OperationalSettingsResponse> {
    const row = await this.getRow();
    return toResponse(row);
  }

  /** Fila cruda tal como está en BD — para consumo interno de otros módulos (delivery, orders). */
  async getRow() {
    return this.db
      .selectFrom('operational_settings')
      .selectAll()
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
  }

  async update(dto: UpdateOperationalSettingsDto): Promise<OperationalSettingsResponse> {
    await this.assertAvailabilityAfter(dto);
    await this.assertPricingAfter(dto);

    const row = await this.db
      .updateTable('operational_settings')
      .set({
        ...(dto.rainSurchargeEnabled !== undefined
          ? { rain_surcharge_enabled: dto.rainSurchargeEnabled }
          : {}),
        ...(dto.rainSurchargeAmount !== undefined
          ? { rain_surcharge_amount: dto.rainSurchargeAmount.toFixed(2) }
          : {}),
        ...(dto.businessOpensHour !== undefined
          ? { business_opens_hour: dto.businessOpensHour }
          : {}),
        ...(dto.businessClosesHour !== undefined
          ? { business_closes_hour: dto.businessClosesHour }
          : {}),
        ...(dto.restaurantLatitude !== undefined
          ? { restaurant_latitude: dto.restaurantLatitude }
          : {}),
        ...(dto.restaurantLongitude !== undefined
          ? { restaurant_longitude: dto.restaurantLongitude }
          : {}),
        ...(dto.serviceDeliveryEnabled !== undefined
          ? { service_delivery_enabled: dto.serviceDeliveryEnabled }
          : {}),
        ...(dto.servicePickupEnabled !== undefined
          ? { service_pickup_enabled: dto.servicePickupEnabled }
          : {}),
        ...(dto.serviceDineInEnabled !== undefined
          ? { service_dine_in_enabled: dto.serviceDineInEnabled }
          : {}),
        ...(dto.channelPosEnabled !== undefined
          ? { channel_pos_enabled: dto.channelPosEnabled }
          : {}),
        ...(dto.channelWhatsappEnabled !== undefined
          ? { channel_whatsapp_enabled: dto.channelWhatsappEnabled }
          : {}),
        ...(dto.channelWebEnabled !== undefined
          ? { channel_web_enabled: dto.channelWebEnabled }
          : {}),
        ...(dto.channelExternalEnabled !== undefined
          ? { channel_external_enabled: dto.channelExternalEnabled }
          : {}),
        ...(dto.minOrderDelivery !== undefined
          ? { min_order_delivery: dto.minOrderDelivery.toFixed(2) }
          : {}),
        ...(dto.minOrderPickup !== undefined
          ? { min_order_pickup: dto.minOrderPickup.toFixed(2) }
          : {}),
        ...(dto.minOrderDineIn !== undefined
          ? { min_order_dine_in: dto.minOrderDineIn.toFixed(2) }
          : {}),
        ...(dto.deliveryPricingMode !== undefined
          ? { delivery_pricing_mode: dto.deliveryPricingMode }
          : {}),
        ...(dto.deliveryFixedFee !== undefined
          ? { delivery_fixed_fee: dto.deliveryFixedFee === null ? null : dto.deliveryFixedFee.toFixed(2) }
          : {}),
        ...(dto.deliveryFreeOverAmount !== undefined
          ? {
              delivery_free_over_amount:
                dto.deliveryFreeOverAmount === null ? null : dto.deliveryFreeOverAmount.toFixed(2),
            }
          : {}),
        ...(dto.deliveryMaxDistanceMeters !== undefined
          ? { delivery_max_distance_meters: dto.deliveryMaxDistanceMeters }
          : {}),
        ...(dto.requireOpenRegister !== undefined
          ? { require_open_register: dto.requireOpenRegister }
          : {}),
        ...(dto.outOfHoursPolicy !== undefined
          ? { out_of_hours_policy: dto.outOfHoursPolicy }
          : {}),
        ...(dto.manualQuoteMaxAmount !== undefined
          ? { manual_quote_max_amount: dto.manualQuoteMaxAmount.toFixed(2) }
          : {}),
        ...(dto.cashPrepaymentRequired !== undefined
          ? { cash_prepayment_required: dto.cashPrepaymentRequired }
          : {}),
        updated_at: new Date(),
      })
      .where('id', '=', true)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toResponse(row);
  }

  /** Modo `fixed` sin monto fijo dejaría el envío sin precio: se rechaza antes de escribir. */
  private async assertPricingAfter(dto: UpdateOperationalSettingsDto): Promise<void> {
    if (dto.deliveryPricingMode === undefined && dto.deliveryFixedFee === undefined) return;
    const current = await this.getRow();
    const mode = dto.deliveryPricingMode ?? current.delivery_pricing_mode;
    const fixedFee =
      dto.deliveryFixedFee !== undefined ? dto.deliveryFixedFee : current.delivery_fixed_fee;
    if (mode === 'fixed' && fixedFee === null) {
      throw new ValidationError(
        "Con deliveryPricingMode='fixed' hay que definir deliveryFixedFee.",
      );
    }
  }

  /**
   * Valida el estado que quedaría (fila actual + cambios) antes de escribir:
   * ver `assertAvailabilityConsistent`. Solo consulta las formas de pago si el
   * cambio toca servicios o canales.
   */
  private async assertAvailabilityAfter(dto: UpdateOperationalSettingsDto): Promise<void> {
    const touches = [
      dto.serviceDeliveryEnabled,
      dto.servicePickupEnabled,
      dto.serviceDineInEnabled,
      dto.channelPosEnabled,
      dto.channelWhatsappEnabled,
      dto.channelWebEnabled,
      dto.channelExternalEnabled,
    ].some((value) => value !== undefined);
    if (!touches) return;

    const current = await this.getRow();
    const next: AvailabilityRow = {
      service_delivery_enabled: dto.serviceDeliveryEnabled ?? current.service_delivery_enabled,
      service_pickup_enabled: dto.servicePickupEnabled ?? current.service_pickup_enabled,
      service_dine_in_enabled: dto.serviceDineInEnabled ?? current.service_dine_in_enabled,
      channel_pos_enabled: dto.channelPosEnabled ?? current.channel_pos_enabled,
      channel_whatsapp_enabled: dto.channelWhatsappEnabled ?? current.channel_whatsapp_enabled,
      channel_web_enabled: dto.channelWebEnabled ?? current.channel_web_enabled,
      channel_external_enabled: dto.channelExternalEnabled ?? current.channel_external_enabled,
    };
    const paymentOptions = await this.db
      .selectFrom('payment_options')
      .select(['service_type', 'enabled'])
      .execute();
    assertAvailabilityConsistent(
      serviceAvailability(next),
      channelAvailability(next),
      paymentOptions,
    );
  }
}

function toResponse(row: {
  rain_surcharge_enabled: boolean;
  rain_surcharge_amount: string;
  business_opens_hour: number;
  business_closes_hour: number;
  restaurant_latitude: number | null;
  restaurant_longitude: number | null;
  service_delivery_enabled: boolean;
  service_pickup_enabled: boolean;
  service_dine_in_enabled: boolean;
  channel_pos_enabled: boolean;
  channel_whatsapp_enabled: boolean;
  channel_web_enabled: boolean;
  channel_external_enabled: boolean;
  min_order_delivery: string;
  min_order_pickup: string;
  min_order_dine_in: string;
  delivery_pricing_mode: 'bands' | 'fixed' | 'free';
  delivery_fixed_fee: string | null;
  delivery_free_over_amount: string | null;
  delivery_max_distance_meters: number | null;
  require_open_register: boolean;
  out_of_hours_policy: 'queue' | 'reject' | 'accept';
  manual_quote_max_amount: string;
  cash_prepayment_required: boolean;
}): OperationalSettingsResponse {
  return {
    rainSurchargeEnabled: row.rain_surcharge_enabled,
    rainSurchargeAmount: Number(row.rain_surcharge_amount),
    businessOpensHour: row.business_opens_hour,
    businessClosesHour: row.business_closes_hour,
    restaurantLatitude: row.restaurant_latitude,
    restaurantLongitude: row.restaurant_longitude,
    serviceDeliveryEnabled: row.service_delivery_enabled,
    servicePickupEnabled: row.service_pickup_enabled,
    serviceDineInEnabled: row.service_dine_in_enabled,
    channelPosEnabled: row.channel_pos_enabled,
    channelWhatsappEnabled: row.channel_whatsapp_enabled,
    channelWebEnabled: row.channel_web_enabled,
    channelExternalEnabled: row.channel_external_enabled,
    minOrderDelivery: Number(row.min_order_delivery),
    minOrderPickup: Number(row.min_order_pickup),
    minOrderDineIn: Number(row.min_order_dine_in),
    deliveryPricingMode: row.delivery_pricing_mode,
    deliveryFixedFee: row.delivery_fixed_fee === null ? null : Number(row.delivery_fixed_fee),
    deliveryFreeOverAmount:
      row.delivery_free_over_amount === null ? null : Number(row.delivery_free_over_amount),
    deliveryMaxDistanceMeters: row.delivery_max_distance_meters,
    requireOpenRegister: row.require_open_register,
    outOfHoursPolicy: row.out_of_hours_policy,
    manualQuoteMaxAmount: Number(row.manual_quote_max_amount),
    cashPrepaymentRequired: row.cash_prepayment_required,
  };
}
