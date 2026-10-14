import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely, Transaction } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import {
  DomainException,
  NotFoundDomainError,
  ValidationError,
} from '../common/exceptions/domain-exception';
import { OperationalSettingsService } from '../operational-settings/operational-settings.service';
import {
  assertServiceTypeEnabled,
  serviceAvailability,
} from '../operational-settings/availability.rules';
import { DeliveryFee, DeliveryTariffService } from './delivery-tariff.service';
import {
  assertManualQuoteAmount,
  automaticCeilingMeters,
  PricingSettings,
  resolveDeliveryFee,
} from './delivery-pricing';
import { DISTANCE_SERVICE, DistanceService } from './distance/distance.service';
import { QuoteDeliveryDto } from './dto/quote-delivery.dto';
import { composeStandaloneQuote } from './standalone-quote';

export interface StandaloneQuoteResponse {
  id: string;
  status: 'quoted' | 'manual_quote' | 'failed';
  distanceMeters: number | null;
  /** Tarifa de la banda (sin recargo). */
  feeAmount: number | null;
  /** Recargo por lluvia vigente al cotizar (0 si no hay). null si no hubo tarifa automática. */
  surchargeAmount: number | null;
  /** feeAmount + surchargeAmount: el monto final real de delivery. null si no hubo tarifa automática. */
  totalAmount: number | null;
  errorCode: string | null;
}

export interface OrderQuoteResponse {
  result: 'applied' | 'already_applied' | 'pending_manual';
  orderId: string;
  deliveryDistanceMeters: number | null;
  deliveryBaseAmount: number | null;
  deliverySurchargeAmount: number | null;
  totalAmount: number | null;
  status: string;
  deliveryQuoteStatus: string | null;
}

/**
 * Cotización de delivery. Portado de apply_delivery_quote_v3 /
 * apply_manual_delivery_quote_v2 / mark_delivery_quote_result_v2
 * (el sistema anterior) — mismas guardas y mismo orden de operaciones, adaptado al
 * esquema nuevo (orders.delivery_base_amount/delivery_surcharge_amount ya
 * separados; sin `out_of_coverage`, que la v2 nunca podía producir).
 */
@Injectable()
export class DeliveryService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly tariff: DeliveryTariffService,
    @Inject(DISTANCE_SERVICE) private readonly distance: DistanceService,
    private readonly operationalSettings: OperationalSettingsService,
  ) {}

  /** POST /delivery/quotes — standalone, sin pedido asociado todavía. */
  async quoteStandalone(
    dto: QuoteDeliveryDto,
    idempotencyKey: string,
  ): Promise<StandaloneQuoteResponse> {
    const existing = await this.db
      .selectFrom('delivery_quote_requests')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existing) return toStandaloneResponse(existing);

    const settings = await this.operationalSettings.getRow();
    assertServiceTypeEnabled(serviceAvailability(settings), 'delivery');
    const origin = this.requireRestaurantOrigin(settings);
    const { meters, source } = await this.distance.metersBetween(origin, {
      latitude: dto.latitude,
      longitude: dto.longitude,
    });
    const fee = await this.resolveFee(settings, meters, dto.subtotalAmount ?? null);
    const amounts = composeStandaloneQuote(fee, {
      enabled: settings.rain_surcharge_enabled,
      amount: Number(settings.rain_surcharge_amount),
    });

    const values = fee.ok && amounts
      ? {
          idempotency_key: idempotencyKey,
          latitude: dto.latitude,
          longitude: dto.longitude,
          status: 'quoted' as const,
          distance_meters: meters,
          distance_source: source,
          fee_amount: amounts.feeAmount.toFixed(2),
          surcharge_amount: amounts.surchargeAmount.toFixed(2),
          error_code: null,
        }
      : {
          idempotency_key: idempotencyKey,
          latitude: dto.latitude,
          longitude: dto.longitude,
          status: (!fee.ok && fee.reason === 'manual_quote' ? 'manual_quote' : 'failed') as
            'manual_quote' | 'failed',
          distance_meters: !fee.ok && fee.reason === 'manual_quote' ? meters : null,
          distance_source: !fee.ok && fee.reason === 'manual_quote' ? source : null,
          fee_amount: null,
          surcharge_amount: null,
          error_code: fee.ok ? null : fee.reason,
        };

    const inserted = await this.db
      .insertInto('delivery_quote_requests')
      .values(values)
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) return toStandaloneResponse(inserted);

    // Perdió la carrera del INSERT: otra request con la misma key ya escribió.
    const winner = await this.db
      .selectFrom('delivery_quote_requests')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirstOrThrow();
    return toStandaloneResponse(winner);
  }

  /**
   * POST /orders/:id/delivery/quote — atado a pedido, dispara tras attach de
   * GPS (ver OrdersService.attachLocation). Aplica tarifa + recargo por
   * lluvia CONGELADO en la misma transacción, o marca 'pending_manual' si
   * excede el techo automático.
   */
  async quoteForOrder(orderId: string): Promise<OrderQuoteResponse> {
    return this.db.transaction().execute((trx) => this.quoteForOrderInTransaction(trx, orderId));
  }

  /**
   * Mismo cuerpo que `quoteForOrder`, dentro de una transacción ajena: lo usa
   * `OrdersService.applyLocationLocked` para guardar la ubicación y cotizar de
   * forma atómica. Otra conexión bloqueando la misma fila (FOR UPDATE) se
   * quedaría esperando a la del llamador, por eso no abre transacción propia.
   */
  async quoteForOrderInTransaction(
    trx: Transaction<Database>,
    orderId: string,
  ): Promise<OrderQuoteResponse> {
    {
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw new NotFoundDomainError('order', orderId);

      if (order.delivery_type !== 'delivery') {
        throw new ValidationError('El pedido no es de delivery.');
      }
      if (order.delivery_pricing !== 'dynamic') {
        throw new ValidationError('El pedido no usa pricing dinámico de delivery.');
      }

      // Idempotencia: una cotización ya cerrada NUNCA se recalcula.
      if (order.delivery_quote_status === 'quoted') {
        return {
          result: 'already_applied',
          orderId: order.id,
          deliveryDistanceMeters: order.delivery_distance_meters,
          deliveryBaseAmount:
            order.delivery_base_amount === null ? null : Number(order.delivery_base_amount),
          deliverySurchargeAmount: Number(order.delivery_surcharge_amount),
          totalAmount: Number(order.total_amount),
          status: order.status,
          deliveryQuoteStatus: order.delivery_quote_status,
        };
      }

      if (
        order.status !== 'awaiting_location' ||
        order.delivery_quote_status === null ||
        !['pending', 'failed'].includes(order.delivery_quote_status)
      ) {
        throw new DomainException(
          'order_not_quotable',
          HttpStatus.CONFLICT,
          `El pedido no está en un estado cotizable (status=${order.status}, quote=${order.delivery_quote_status}).`,
        );
      }

      if (order.delivery_latitude === null || order.delivery_longitude === null) {
        throw new ValidationError('El pedido todavía no tiene ubicación adjunta.');
      }

      const settings = await this.operationalSettings.getRow();
      const origin = this.requireRestaurantOrigin(settings);
      const { meters } = await this.distance.metersBetween(origin, {
        latitude: order.delivery_latitude,
        longitude: order.delivery_longitude,
      });
      const fee = await this.resolveFee(settings, meters, Number(order.subtotal_amount), trx);

      if (!fee.ok) {
        // Por encima del techo: NO se escribe delivery_amount (un delivery en
        // Bs 0 sería un total incorrecto). Queda pending_manual, vivo.
        await trx
          .updateTable('orders')
          .set({ delivery_quote_status: 'pending_manual', delivery_distance_meters: meters })
          .where('id', '=', order.id)
          .execute();

        return {
          result: 'pending_manual',
          orderId: order.id,
          deliveryDistanceMeters: meters,
          deliveryBaseAmount: null,
          deliverySurchargeAmount: null,
          totalAmount: Number(order.total_amount),
          status: order.status,
          deliveryQuoteStatus: 'pending_manual',
        };
      }

      // EL CONGELADO: dentro de la misma transacción, con el pedido bloqueado.
      // Envío gratis por política: tampoco lleva recargo por lluvia.
      const surcharge =
        settings.rain_surcharge_enabled && !fee.free ? Number(settings.rain_surcharge_amount) : 0;
      const totalAmount = Number(order.subtotal_amount) + fee.amount + surcharge;

      await trx
        .updateTable('orders')
        .set({
          delivery_distance_meters: meters,
          delivery_base_amount: fee.amount.toFixed(2),
          delivery_surcharge_amount: surcharge.toFixed(2),
          total_amount: totalAmount.toFixed(2),
          delivery_quote_status: 'quoted',
          status: 'confirmed',
          confirmed_at: order.confirmed_at ?? new Date(),
        })
        .where('id', '=', order.id)
        .execute();

      return {
        result: 'applied',
        orderId: order.id,
        deliveryDistanceMeters: meters,
        deliveryBaseAmount: fee.amount,
        deliverySurchargeAmount: surcharge,
        totalAmount,
        status: 'confirmed',
        deliveryQuoteStatus: 'quoted',
      };
    }
  }

  /** POST /orders/:id/delivery/quote/manual — staff fija el monto a mano (solo por encima del techo). */
  async setManualQuote(orderId: string, amount: number): Promise<OrderQuoteResponse> {
    const currentSettings = await this.operationalSettings.getRow();
    assertManualQuoteAmount(amount, Number(currentSettings.manual_quote_max_amount));

    return this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw new NotFoundDomainError('order', orderId);

      if (order.delivery_type !== 'delivery') {
        throw new ValidationError('El pedido no es de delivery.');
      }
      if (order.delivery_pricing !== 'dynamic') {
        throw new ValidationError('El pedido no usa pricing dinámico de delivery.');
      }

      const cap = await this.automaticCeiling(currentSettings, trx);
      if (
        cap === null ||
        order.delivery_distance_meters === null ||
        order.delivery_distance_meters <= cap
      ) {
        throw new DomainException(
          'manual_quote_not_applicable',
          HttpStatus.CONFLICT,
          cap === null
            ? 'No hay techo de reparto automático configurado: el envío nunca se cotiza a mano.'
            : `La cotización manual solo aplica por encima del techo automático (${cap} m).`,
        );
      }

      if (order.delivery_quote_status === 'quoted') {
        return {
          result: 'already_applied',
          orderId: order.id,
          deliveryDistanceMeters: order.delivery_distance_meters,
          deliveryBaseAmount:
            order.delivery_base_amount === null ? null : Number(order.delivery_base_amount),
          deliverySurchargeAmount: Number(order.delivery_surcharge_amount),
          totalAmount: Number(order.total_amount),
          status: order.status,
          deliveryQuoteStatus: order.delivery_quote_status,
        };
      }

      if (order.delivery_quote_status !== 'pending_manual') {
        throw new DomainException(
          'order_not_pending_manual',
          HttpStatus.CONFLICT,
          `El pedido no está en pending_manual (quote=${order.delivery_quote_status}).`,
        );
      }
      if (order.status !== 'awaiting_location') {
        throw new DomainException(
          'order_not_quotable',
          HttpStatus.CONFLICT,
          `El pedido no está en awaiting_location (status=${order.status}).`,
        );
      }

      const settings = await this.operationalSettings.getRow();
      const surcharge = settings.rain_surcharge_enabled
        ? Number(settings.rain_surcharge_amount)
        : 0;
      const totalAmount = Number(order.subtotal_amount) + amount + surcharge;

      await trx
        .updateTable('orders')
        .set({
          delivery_base_amount: amount.toFixed(2),
          delivery_surcharge_amount: surcharge.toFixed(2),
          total_amount: totalAmount.toFixed(2),
          delivery_quote_status: 'quoted',
          status: 'confirmed',
          confirmed_at: order.confirmed_at ?? new Date(),
        })
        .where('id', '=', order.id)
        .execute();

      return {
        result: 'applied',
        orderId: order.id,
        deliveryDistanceMeters: order.delivery_distance_meters,
        deliveryBaseAmount: amount,
        deliverySurchargeAmount: surcharge,
        totalAmount,
        status: 'confirmed',
        deliveryQuoteStatus: 'quoted',
      };
    });
  }

  /** Política de envío del local según `operational_settings` (ver `resolveDeliveryFee`). */
  private resolveFee(
    settings: Parameters<typeof pricingSettingsFrom>[0],
    meters: number,
    subtotal: number | null,
    executor?: Transaction<Database>,
  ): Promise<DeliveryFee> {
    return resolveDeliveryFee({
      settings: pricingSettingsFrom(settings),
      meters,
      subtotal,
      bandFee: () => this.tariff.feeForMeters(meters, executor),
    });
  }

  /** Distancia máxima que se cotiza sola; null = sin techo (solo en fixed/free sin techo). */
  private async automaticCeiling(
    settings: Parameters<typeof pricingSettingsFrom>[0],
    executor: Transaction<Database>,
  ): Promise<number | null> {
    const pricing = pricingSettingsFrom(settings);
    const bandsMax = pricing.mode === 'bands' ? await this.tariff.maxAutomaticMeters(executor) : null;
    return automaticCeilingMeters(pricing, bandsMax);
  }

  private requireRestaurantOrigin(settings: {
    restaurant_latitude: number | null;
    restaurant_longitude: number | null;
  }) {
    if (settings.restaurant_latitude === null || settings.restaurant_longitude === null) {
      throw new DomainException(
        'restaurant_location_not_configured',
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Faltan las coordenadas del restaurante en operational_settings.',
      );
    }
    return { latitude: settings.restaurant_latitude, longitude: settings.restaurant_longitude };
  }
}

/** Fila de operational_settings → política de envío. Sin columnas (mocks viejos) = bandas, como antes. */
function pricingSettingsFrom(row: {
  delivery_pricing_mode?: 'bands' | 'fixed' | 'free';
  delivery_fixed_fee?: string | null;
  delivery_free_over_amount?: string | null;
  delivery_max_distance_meters?: number | null;
}): PricingSettings {
  return {
    mode: row.delivery_pricing_mode ?? 'bands',
    fixedFee: row.delivery_fixed_fee == null ? null : Number(row.delivery_fixed_fee),
    freeOverAmount: row.delivery_free_over_amount == null ? null : Number(row.delivery_free_over_amount),
    maxDistanceMeters: row.delivery_max_distance_meters ?? null,
  };
}

function toStandaloneResponse(row: {
  id: string;
  status: string;
  distance_meters: number | null;
  fee_amount: string | null;
  surcharge_amount: string | null;
  error_code: string | null;
}): StandaloneQuoteResponse {
  const feeAmount = row.fee_amount === null ? null : Number(row.fee_amount);
  // Filas anteriores a la columna: surcharge null = sin recargo.
  const surchargeAmount = feeAmount === null ? null : Number(row.surcharge_amount ?? 0);
  return {
    id: row.id,
    status: row.status as StandaloneQuoteResponse['status'],
    distanceMeters: row.distance_meters,
    feeAmount,
    surchargeAmount,
    totalAmount:
      feeAmount === null || surchargeAmount === null
        ? null
        : Math.round((feeAmount + surchargeAmount) * 100) / 100,
    errorCode: row.error_code,
  };
}
