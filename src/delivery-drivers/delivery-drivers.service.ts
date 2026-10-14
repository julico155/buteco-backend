import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database, OrderPromotionComponentSnapshot } from '../database/types';
import { AppConfig } from '../config/configuration';
import { DomainException, NotFoundDomainError } from '../common/exceptions/domain-exception';
import { OperationalSettingsService } from '../operational-settings/operational-settings.service';
import { HaversineDistanceService } from '../delivery/distance/distance.service';
import { JwtPayload } from '../auth/auth.service';
import { AcceptDeliveryOrderDto } from './dto/accept-delivery-order.dto';
import { dateInBolivia } from '../common/time/service-window';
import { resolveDateRange } from '../reports/reports.range';
import {
  checkDriverPresence,
  groupNearbyOrders,
  mapsUrl,
  presenceException,
  resolveHistoryDriverId,
} from './delivery-drivers.rules';

export interface AvailableDeliveryOrder {
  id: string;
  orderNumber: string;
  itemsCount: number;
  deliveryDistanceMeters: number | null;
  /** Solo para informar: el envío se le paga al repartidor y no se cuadra en el sistema. */
  deliveryFeeAmount: number;
  readySince: string;
  /**
   * Ubicación de entrega, visible ya en "disponibles" (decisión del dueño del
   * negocio: quiere que el repartidor la vea a ojo en el mapa antes de
   * aceptar, para agrupar viajes) — null si el pedido todavía no tiene
   * cotización de distancia. El nombre/teléfono del cliente SÍ sigue oculto
   * hasta aceptar (`MyDeliveryOrder`).
   */
  latitude: number | null;
  longitude: number | null;
  mapsUrl: string | null;
  /** Otros pedidos disponibles a menos de `deliveryNearbyRadiusMeters` de ESTE — atajo para no tener que comparar pines a ojo. */
  nearbyOrders: { id: string; orderNumber: string; distanceMeters: number }[];
}

export interface MyDeliveryOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string | null;
  latitude: number | null;
  longitude: number | null;
  mapsUrl: string | null;
  notes: string | null;
  items: { name: string; quantity: number; excludedComplements: string[] }[];
  promotions: { name: string; comboQuantity: number; components: OrderPromotionComponentSnapshot[] }[];
  deliveryFeeAmount: number;
  acceptedAt: string | null;
}

export interface DeliveryHistoryQuery {
  from?: string;
  to?: string;
  driverId?: string;
  limit: number;
  offset: number;
}

const iso = (value: Date | string | null): string | null =>
  value ? new Date(value).toISOString() : null;

/**
 * Flujo del repartidor: ve los pedidos `ready` de delivery (con ubicación,
 * para poder agrupar viajes a ojo en el mapa — pero SIN nombre/teléfono del
 * cliente todavía), acepta los que va a llevar estando en el local, y al
 * llegar los marca entregados. Las reglas de negocio (radio, quién puede
 * mover qué) viven en `delivery-drivers.rules.ts`.
 */
@Injectable()
export class DeliveryDriversService {
  private readonly distance = new HaversineDistanceService();

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly operationalSettings: OperationalSettingsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async listAvailable(): Promise<AvailableDeliveryOrder[]> {
    const orders = await this.db
      .selectFrom('orders')
      .select([
        'id',
        'order_number',
        'delivery_distance_meters',
        'delivery_base_amount',
        'delivery_surcharge_amount',
        'delivery_latitude',
        'delivery_longitude',
        'updated_at',
      ])
      .where('status', '=', 'ready')
      .where('delivery_type', '=', 'delivery')
      .where('delivery_driver_id', 'is', null)
      .orderBy('updated_at', 'asc')
      .execute();
    if (orders.length === 0) return [];

    // Coordenadas SOLO entran acá, nunca al response — groupNearbyOrders
    // devuelve distancias entre pedidos, jamás una lat/lng.
    const withLocation = orders.filter(
      (o): o is typeof o & { delivery_latitude: number; delivery_longitude: number } =>
        o.delivery_latitude !== null && o.delivery_longitude !== null,
    );
    const nearby = groupNearbyOrders(
      withLocation.map((o) => ({
        id: o.id,
        orderNumber: o.order_number,
        latitude: o.delivery_latitude,
        longitude: o.delivery_longitude,
      })),
      this.config.get('deliveryNearbyRadiusMeters', { infer: true }),
    );

    const ids = orders.map((o) => o.id);
    const [items, promotions] = await Promise.all([
      this.db
        .selectFrom('order_items')
        .select(['order_id', 'quantity'])
        .where('order_id', 'in', ids)
        .execute(),
      this.db
        .selectFrom('order_promotions')
        .select(['order_id', 'combo_quantity'])
        .where('order_id', 'in', ids)
        .execute(),
    ]);
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.order_id, (counts.get(i.order_id) ?? 0) + i.quantity);
    for (const p of promotions) {
      counts.set(p.order_id, (counts.get(p.order_id) ?? 0) + p.combo_quantity);
    }

    return orders.map((o) => ({
      id: o.id,
      orderNumber: o.order_number,
      itemsCount: counts.get(o.id) ?? 0,
      deliveryDistanceMeters: o.delivery_distance_meters,
      deliveryFeeAmount: Number(o.delivery_base_amount) + Number(o.delivery_surcharge_amount),
      readySince: new Date(o.updated_at).toISOString(),
      latitude: o.delivery_latitude,
      longitude: o.delivery_longitude,
      mapsUrl:
        o.delivery_latitude !== null && o.delivery_longitude !== null
          ? mapsUrl(o.delivery_latitude, o.delivery_longitude)
          : null,
      nearbyOrders: nearby.get(o.id) ?? [],
    }));
  }

  async listMine(driverId: string): Promise<MyDeliveryOrder[]> {
    const orders = await this.db
      .selectFrom('orders')
      .leftJoin('customers', 'customers.id', 'orders.customer_id')
      .select([
        'orders.id as id',
        'orders.order_number as order_number',
        'orders.customer_name as customer_name',
        'customers.phone as customer_phone',
        'orders.delivery_latitude as latitude',
        'orders.delivery_longitude as longitude',
        'orders.notes as notes',
        'orders.delivery_base_amount as base',
        'orders.delivery_surcharge_amount as surcharge',
        'orders.delivery_accepted_at as accepted_at',
      ])
      .where('orders.delivery_driver_id', '=', driverId)
      .where('orders.status', '=', 'out_for_delivery')
      .orderBy('orders.delivery_accepted_at', 'asc')
      .execute();
    if (orders.length === 0) return [];

    const ids = orders.map((o) => o.id);
    const [items, promotions] = await Promise.all([
      this.db.selectFrom('order_items').selectAll().where('order_id', 'in', ids).execute(),
      this.db.selectFrom('order_promotions').selectAll().where('order_id', 'in', ids).execute(),
    ]);

    return orders.map((o) => ({
      id: o.id,
      orderNumber: o.order_number,
      customerName: o.customer_name,
      customerPhone: o.customer_phone,
      latitude: o.latitude,
      longitude: o.longitude,
      mapsUrl: o.latitude !== null && o.longitude !== null ? mapsUrl(o.latitude, o.longitude) : null,
      notes: o.notes,
      items: items
        .filter((i) => i.order_id === o.id)
        .map((i) => ({
          name: i.product_name_snapshot,
          quantity: i.quantity,
          excludedComplements: i.excluded_complements,
        })),
      promotions: promotions
        .filter((p) => p.order_id === o.id)
        .map((p) => ({
          name: p.promotion_name_snapshot,
          comboQuantity: p.combo_quantity,
          components: p.components_snapshot,
        })),
      deliveryFeeAmount: Number(o.base) + Number(o.surcharge),
      acceptedAt: iso(o.accepted_at),
    }));
  }

  /**
   * Entregas ya hechas, filtradas por `delivered_at` (fecha de Bolivia). Sin
   * `from`/`to` devuelve las de hoy. `totals` cubre el filtro completo, no
   * solo la página — es lo que se le muestra al repartidor/cajero para
   * cuadrar la noche. `cashCollectedTotal`/`cashPendingTotal` suman el
   * pedido COMPLETO (comida + envío) de los `payment_method='cash'` — esto
   * es aparte del cierre de caja del POS (`CashRegisterService`): el
   * efectivo que trae puesta la moto se cuadra acá, a mano, no contra una
   * sesión de caja (ver `deliver`).
   */
  async listHistory(actor: JwtPayload, query: DeliveryHistoryQuery) {
    const driverId = resolveHistoryDriverId(actor, query.driverId);
    const today = dateInBolivia(new Date());
    const range =
      query.from || query.to ? resolveDateRange(query.from, query.to) : resolveDateRange(today, today);

    const base = () =>
      this.db
        .selectFrom('orders')
        .where('status', '=', 'delivered')
        .where('delivered_at', '>=', range.start)
        .where('delivered_at', '<', range.end)
        .$if(driverId !== null, (qb) => qb.where('delivery_driver_id', '=', driverId as string));

    const [totals, rows] = await Promise.all([
      base()
        .select([
          sql<string>`count(*)`.as('deliveries'),
          sql<string>`coalesce(sum(delivery_base_amount + delivery_surcharge_amount), 0)`.as('fees'),
          sql<string>`coalesce(sum(case when payment_method = 'cash' and payment_status = 'paid' then total_amount else 0 end), 0)`.as(
            'cash_collected',
          ),
          sql<string>`coalesce(sum(case when payment_method = 'cash' and payment_status != 'paid' then total_amount else 0 end), 0)`.as(
            'cash_pending',
          ),
        ])
        .executeTakeFirstOrThrow(),
      base()
        .select([
          'id',
          'order_number',
          'customer_name',
          'delivery_driver_id',
          'delivery_driver_name',
          'delivery_accepted_at',
          'delivered_at',
          'delivery_distance_meters',
          'delivery_base_amount',
          'delivery_surcharge_amount',
          'payment_method',
          'payment_status',
          'total_amount',
        ])
        .orderBy('delivered_at', 'desc')
        .orderBy('id')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
    ]);

    return {
      totals: {
        deliveries: Number(totals.deliveries),
        deliveryFeeTotal: Math.round(Number(totals.fees) * 100) / 100,
        // Pedidos 'cash' ya cobrados (confirmados al entregar) vs. los que
        // el repartidor marcó como no cobrados — eso último se le descuenta
        // a la moto, fuera del sistema.
        cashCollectedTotal: Math.round(Number(totals.cash_collected) * 100) / 100,
        cashPendingTotal: Math.round(Number(totals.cash_pending) * 100) / 100,
      },
      limit: query.limit,
      offset: query.offset,
      orders: rows.map((o) => ({
        id: o.id,
        orderNumber: o.order_number,
        customerName: o.customer_name,
        driverId: o.delivery_driver_id,
        driverName: o.delivery_driver_name,
        acceptedAt: iso(o.delivery_accepted_at),
        deliveredAt: iso(o.delivered_at),
        deliveryDistanceMeters: o.delivery_distance_meters,
        deliveryFeeAmount: Number(o.delivery_base_amount) + Number(o.delivery_surcharge_amount),
        paymentMethod: o.payment_method,
        // Para cash: 'paid' = cobrado al entregar; cualquier otra cosa = pendiente de cobrarle a la moto.
        paymentStatus: o.payment_status,
        totalAmount: Number(o.total_amount),
      })),
    };
  }

  async accept(
    orderId: string,
    driver: JwtPayload,
    dto: AcceptDeliveryOrderDto,
  ): Promise<MyDeliveryOrder> {
    const settings = await this.operationalSettings.getRow();
    if (settings.restaurant_latitude === null || settings.restaurant_longitude === null) {
      throw new DomainException(
        'restaurant_location_not_configured',
        HttpStatus.CONFLICT,
        'El local no tiene coordenadas configuradas; un admin tiene que cargarlas en operational-settings.',
      );
    }

    const radius = this.config.get('deliveryAcceptRadiusMeters', { infer: true });
    const { meters } = await this.distance.metersBetween(
      { latitude: dto.latitude, longitude: dto.longitude },
      { latitude: settings.restaurant_latitude, longitude: settings.restaurant_longitude },
    );
    const presence = checkDriverPresence(meters, dto.accuracyMeters, radius);
    if (!presence.ok) throw presenceException(presence, meters, radius);

    // CAS: dos repartidores aceptando el mismo pedido a la vez — gana uno solo.
    const taken = await this.db
      .updateTable('orders')
      .set({
        delivery_driver_id: driver.sub,
        delivery_driver_name: driver.username,
        delivery_accepted_at: new Date(),
        status: 'out_for_delivery',
        status_updated_by: driver.username,
        updated_at: new Date(),
      })
      .where('id', '=', orderId)
      .where('status', '=', 'ready')
      .where('delivery_type', '=', 'delivery')
      .where('delivery_driver_id', 'is', null)
      .returning('id')
      .executeTakeFirst();

    if (!taken) {
      const existing = await this.db
        .selectFrom('orders')
        .select(['status', 'delivery_type', 'delivery_driver_id'])
        .where('id', '=', orderId)
        .executeTakeFirst();
      if (!existing) throw new NotFoundDomainError('order', orderId);
      if (existing.delivery_driver_id) {
        throw new DomainException(
          'order_already_taken',
          HttpStatus.CONFLICT,
          'Otro repartidor ya aceptó este pedido.',
        );
      }
      throw new DomainException(
        'order_not_ready',
        HttpStatus.CONFLICT,
        'El pedido no es un delivery listo para retirar.',
        { status: existing.status, deliveryType: existing.delivery_type },
      );
    }

    const mine = await this.listMine(driver.sub);
    const accepted = mine.find((o) => o.id === orderId);
    if (!accepted) throw new NotFoundDomainError('order', orderId);
    return accepted;
  }

  /**
   * `cashCollected` solo importa para `payment_method='cash'` y todavía
   * impago: marca `payment_status='paid'` en el mismo golpe que `delivered`
   * (el repartidor cobra y entrega en el mismo momento real). Si el cliente
   * no pagó (`cashCollected: false`), el pedido se entrega igual — el
   * negocio no bloquea la entrega por eso, se cuadra aparte con la moto — y
   * queda `unpaid` para que el cuadre de fin de noche (`listHistory`) lo
   * muestre como pendiente de cobrarle al repartidor. Nunca ata esto a una
   * sesión de caja (a diferencia de `OrdersService.confirmCash`): la plata
   * se cobró en la calle, no en el mostrador, y el cuadre de motos es un
   * proceso aparte, manual, a fin de noche — no el cierre de caja del POS.
   */
  async deliver(
    orderId: string,
    driver: JwtPayload,
    cashCollected = true,
  ): Promise<{ id: string; deliveredAt: string }> {
    const order = await this.db
      .selectFrom('orders')
      .select(['id', 'status', 'delivery_driver_id', 'payment_method', 'payment_status'])
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);
    if (order.delivery_driver_id !== driver.sub && driver.role !== 'admin') {
      throw new DomainException(
        'not_your_order',
        HttpStatus.FORBIDDEN,
        'Este pedido lo tiene otro repartidor.',
      );
    }

    const confirmsCash =
      order.payment_method === 'cash' && order.payment_status !== 'paid' && cashCollected;
    const now = new Date();
    const delivered = await this.db
      .updateTable('orders')
      .set({
        status: 'delivered',
        delivered_at: now,
        status_updated_by: driver.username,
        updated_at: now,
        ...(confirmsCash ? { payment_status: 'paid' as const, cash_confirmed_at: now } : {}),
      })
      .where('id', '=', orderId)
      .where('status', '=', 'out_for_delivery')
      .returning('id')
      .executeTakeFirst();
    if (!delivered) {
      throw new DomainException(
        'order_not_out_for_delivery',
        HttpStatus.CONFLICT,
        'El pedido no está en reparto.',
        { status: order.status },
      );
    }
    return { id: orderId, deliveredAt: now.toISOString() };
  }
}
