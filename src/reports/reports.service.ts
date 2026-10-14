import { Inject, Injectable } from '@nestjs/common';
import { Expression, ExpressionBuilder, Kysely, sql, SqlBool } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { NotFoundDomainError } from '../common/exceptions/domain-exception';
import { SERVICE_TIME_ZONE } from '../common/time/service-window';
import { toResponse as toCashSessionResponse } from '../cash-register/cash-register.service';
import { computeKpis, KpiGroupRow, KpisResult, round2 } from './reports.kpis';
import { DateRange, resolveDateRange, SalesFilters } from './reports.range';

const iso = (value: Date | string | null): string | null =>
  value ? new Date(value).toISOString() : null;

/** Condiciones de `orders` compartidas por todos los reportes. */
function orderConditions(
  eb: ExpressionBuilder<Database, 'orders'>,
  f: SalesFilters,
): Expression<SqlBool>[] {
  const c: Expression<SqlBool>[] = [];
  if (f.range) {
    c.push(eb('orders.created_at', '>=', f.range.start));
    c.push(eb('orders.created_at', '<', f.range.end));
  }
  if (f.sessionId) c.push(eb('orders.register_session_id', '=', f.sessionId));
  if (f.channel) c.push(eb('orders.channel', '=', f.channel));
  if (f.paymentMethod) c.push(eb('orders.payment_method', '=', f.paymentMethod));
  if (f.paymentStatus) c.push(eb('orders.payment_status', '=', f.paymentStatus));
  if (f.status) c.push(eb('orders.status', '=', f.status));
  if (f.deliveryType) c.push(eb('orders.delivery_type', '=', f.deliveryType));
  if (f.sold) {
    c.push(eb('orders.payment_status', '=', 'paid'));
    c.push(eb('orders.status', '<>', 'cancelled'));
  }
  return c;
}

/** Los rankings de productos siempre miran solo lo vendido, además de los filtros pedidos. */
function soldConditions(
  eb: ExpressionBuilder<Database, 'orders'>,
  f: SalesFilters,
): Expression<SqlBool>[] {
  return orderConditions(eb, { ...f, sold: true });
}

function groupByOrderId<T extends { order_id: string }>(rows: T[]): Map<string, T[]> {
  const byOrder = new Map<string, T[]>();
  for (const row of rows) {
    const list = byOrder.get(row.order_id) ?? [];
    list.push(row);
    byOrder.set(row.order_id, list);
  }
  return byOrder;
}

@Injectable()
export class ReportsService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async getKpis(filters: SalesFilters) {
    const rows = await this.db
      .selectFrom('orders')
      .select([
        'channel',
        'payment_method',
        'delivery_type',
        'payment_status',
        'status',
        sql<string>`count(*)`.as('orders'),
        sql<string>`coalesce(sum(total_amount), 0)`.as('total'),
      ])
      .where((eb) => eb.and(orderConditions(eb, filters)))
      .groupBy(['channel', 'payment_method', 'delivery_type', 'payment_status', 'status'])
      .execute();

    const kpis: KpisResult = computeKpis(
      rows.map(
        (r): KpiGroupRow => ({
          channel: r.channel,
          payment_method: r.payment_method,
          delivery_type: r.delivery_type,
          payment_status: r.payment_status,
          status: r.status,
          orders: Number(r.orders),
          total: Number(r.total),
        }),
      ),
    );

    return { ...kpis, lateOrderRequests: await this.countLateRequests(filters.range) };
  }

  /** Con filtro por turno sin fechas no hay rango de tiempo con el que contarlos, por eso null. */
  private async countLateRequests(range: DateRange | null) {
    if (!range) return null;
    const rows = await this.db
      .selectFrom('late_order_requests')
      .select(['status', sql<string>`count(*)`.as('count')])
      .where('requested_at', '>=', range.start)
      .where('requested_at', '<', range.end)
      .groupBy('status')
      .execute();
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      byStatus[row.status] = Number(row.count);
      total += Number(row.count);
    }
    return { total, byStatus };
  }

  async getTimeseries(filters: SalesFilters, groupBy: 'day' | 'hour') {
    const format = groupBy === 'hour' ? 'YYYY-MM-DD"T"HH24:00' : 'YYYY-MM-DD';
    const bucket = sql<string>`to_char(orders.created_at at time zone ${sql.lit(SERVICE_TIME_ZONE)}, ${sql.lit(format)})`;
    const rows = await this.db
      .selectFrom('orders')
      .select([
        bucket.as('bucket'),
        sql<string>`count(*)`.as('orders'),
        sql<string>`coalesce(sum(total_amount), 0)`.as('total'),
      ])
      .where((eb) => eb.and(soldConditions(eb, filters)))
      .groupBy(bucket)
      .orderBy('bucket')
      .execute();
    return {
      groupBy,
      timeZone: SERVICE_TIME_ZONE,
      points: rows.map((r) => ({
        bucket: r.bucket,
        orders: Number(r.orders),
        salesAmount: round2(Number(r.total)),
      })),
    };
  }

  async listOrders(filters: SalesFilters, limit: number, offset: number) {
    const [totals, orders] = await Promise.all([
      this.db
        .selectFrom('orders')
        .select([
          sql<string>`count(*)`.as('orders'),
          sql<string>`coalesce(sum(total_amount), 0)`.as('total'),
        ])
        .where((eb) => eb.and(orderConditions(eb, filters)))
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('orders')
        .selectAll()
        .where((eb) => eb.and(orderConditions(eb, filters)))
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(limit)
        .offset(offset)
        .execute(),
    ]);

    const ids = orders.map((o) => o.id);
    const [items, promotions] = ids.length
      ? await Promise.all([
          this.db.selectFrom('order_items').selectAll().where('order_id', 'in', ids).execute(),
          this.db.selectFrom('order_promotions').selectAll().where('order_id', 'in', ids).execute(),
        ])
      : [[], []];
    const itemsByOrder = groupByOrderId(items);
    const promosByOrder = groupByOrderId(promotions);

    return {
      totals: { orders: Number(totals.orders), amount: round2(Number(totals.total)) },
      limit,
      offset,
      orders: orders.map((o) => ({
        id: o.id,
        orderNumber: o.order_number,
        customerName: o.customer_name,
        channel: o.channel,
        deliveryType: o.delivery_type,
        paymentMethod: o.payment_method,
        paymentStatus: o.payment_status,
        status: o.status,
        totalAmount: Number(o.total_amount),
        registerSessionId: o.register_session_id,
        createdAt: iso(o.created_at),
        items: (itemsByOrder.get(o.id) ?? []).map((i) => ({
          productNameSnapshot: i.product_name_snapshot,
          quantity: i.quantity,
          subtotal: Number(i.subtotal),
        })),
        promotions: (promosByOrder.get(o.id) ?? []).map((p) => ({
          promotionNameSnapshot: p.promotion_name_snapshot,
          comboQuantity: p.combo_quantity,
          subtotal: Number(p.subtotal),
        })),
      })),
    };
  }

  async getOrderDetail(orderId: string) {
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);

    const [items, promotions, customer, attempts, qrCharges, session] = await Promise.all([
      this.db.selectFrom('order_items').selectAll().where('order_id', '=', orderId).execute(),
      this.db.selectFrom('order_promotions').selectAll().where('order_id', '=', orderId).execute(),
      order.customer_id
        ? this.db
            .selectFrom('customers')
            .select(['id', 'name', 'phone', 'email'])
            .where('id', '=', order.customer_id)
            .executeTakeFirst()
        : Promise.resolve(undefined),
      this.db
        .selectFrom('payment_attempts')
        .selectAll()
        .where('order_id', '=', orderId)
        .orderBy('opened_at')
        .execute(),
      this.db
        .selectFrom('bank_qr_charges')
        .select([
          'id',
          'payment_attempt_id',
          'qr_id',
          'transaction_id',
          'amount',
          sql<string>`due_date::text`.as('due_date'),
          'status',
          'created_at',
          'updated_at',
        ])
        .where('order_id', '=', orderId)
        .orderBy('created_at')
        .execute(),
      order.register_session_id
        ? this.db
            .selectFrom('cash_register_sessions')
            .selectAll()
            .where('id', '=', order.register_session_id)
            .executeTakeFirst()
        : Promise.resolve(undefined),
    ]);

    return {
      id: order.id,
      orderNumber: order.order_number,
      channel: order.channel,
      deliveryType: order.delivery_type,
      paymentMethod: order.payment_method,
      paymentStatus: order.payment_status,
      status: order.status,
      notes: order.notes,
      customerName: order.customer_name,
      customer: customer
        ? { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email }
        : null,
      amounts: {
        subtotal: Number(order.subtotal_amount),
        deliveryBase: Number(order.delivery_base_amount),
        deliverySurcharge: Number(order.delivery_surcharge_amount),
        total: Number(order.total_amount),
      },
      // Solo con paymentMethod='split' — el resto de los pedidos los trae en null.
      split:
        order.payment_method === 'split'
          ? {
              cashAmount: order.split_cash_amount === null ? null : Number(order.split_cash_amount),
              qrAmount: order.split_qr_amount === null ? null : Number(order.split_qr_amount),
              cashConfirmedAt: iso(order.split_cash_confirmed_at),
            }
          : null,
      delivery: {
        quoteStatus: order.delivery_quote_status,
        distanceMeters: order.delivery_distance_meters,
        feePaid: order.delivery_fee_paid,
        driverName: order.delivery_driver_name,
        acceptedAt: iso(order.delivery_accepted_at),
        deliveredAt: iso(order.delivered_at),
      },
      timestamps: {
        createdAt: iso(order.created_at),
        confirmedAt: iso(order.confirmed_at),
        cashConfirmedAt: iso(order.cash_confirmed_at),
        updatedAt: iso(order.updated_at),
      },
      statusUpdatedBy: order.status_updated_by,
      items: items.map((i) => ({
        productId: i.product_id,
        productCodeSnapshot: i.product_code_snapshot,
        productNameSnapshot: i.product_name_snapshot,
        unitPriceSnapshot: Number(i.unit_price_snapshot),
        quantity: i.quantity,
        subtotal: Number(i.subtotal),
        excludedComplements: i.excluded_complements,
      })),
      promotions: promotions.map((p) => ({
        promotionId: p.promotion_id,
        promotionNameSnapshot: p.promotion_name_snapshot,
        promoPriceSnapshot: Number(p.promo_price_snapshot),
        comboQuantity: p.combo_quantity,
        subtotal: Number(p.subtotal),
        componentsSnapshot: p.components_snapshot,
      })),
      paymentAttempts: attempts.map((a) => ({
        id: a.id,
        openedAs: a.opened_as,
        reviewStatus: a.review_status,
        openedAt: iso(a.opened_at),
        reviewedAt: iso(a.reviewed_at),
      })),
      bankQrCharges: qrCharges.map((q) => ({
        id: q.id,
        paymentAttemptId: q.payment_attempt_id,
        qrId: q.qr_id,
        transactionId: q.transaction_id,
        amount: Number(q.amount),
        dueDate: q.due_date,
        status: q.status,
        createdAt: iso(q.created_at),
        updatedAt: iso(q.updated_at),
      })),
      cashRegisterSession: session ? toCashSessionResponse(session) : null,
    };
  }

  async getTopProducts(filters: SalesFilters, limit: number) {
    const soldOrderIds = this.db
      .selectFrom('orders')
      .select('orders.id')
      .where((eb) => eb.and(soldConditions(eb, filters)));

    const [products, combos, categories] = await Promise.all([
      this.db
        .selectFrom('order_items')
        .select([
          'product_id as productId',
          sql<string>`max(product_name_snapshot)`.as('name'),
          sql<string>`sum(quantity)`.as('quantity'),
          sql<string>`sum(subtotal)`.as('revenue'),
        ])
        .where('order_id', 'in', soldOrderIds)
        .groupBy('product_id')
        .orderBy('revenue', 'desc')
        .limit(limit)
        .execute(),
      this.db
        .selectFrom('order_promotions')
        .select([
          sql<string | null>`max(promotion_id::text)`.as('promotionId'),
          'promotion_name_snapshot as name',
          sql<string>`sum(combo_quantity)`.as('quantity'),
          sql<string>`sum(subtotal)`.as('revenue'),
        ])
        .where('order_id', 'in', soldOrderIds)
        .groupBy('promotion_name_snapshot')
        .orderBy('revenue', 'desc')
        .limit(limit)
        .execute(),
      this.db
        .selectFrom('order_items')
        .innerJoin('products', 'products.id', 'order_items.product_id')
        .innerJoin('categories', 'categories.id', 'products.category_id')
        .select([
          'categories.id as categoryId',
          'categories.name as name',
          sql<string>`sum(order_items.quantity)`.as('quantity'),
          sql<string>`sum(order_items.subtotal)`.as('revenue'),
        ])
        .where('order_items.order_id', 'in', soldOrderIds)
        .groupBy(['categories.id', 'categories.name'])
        .orderBy('revenue', 'desc')
        .execute(),
    ]);

    const map = <T extends { quantity: string; revenue: string }>(rows: T[]) =>
      rows.map((r) => ({ ...r, quantity: Number(r.quantity), revenue: round2(Number(r.revenue)) }));

    return { products: map(products), combos: map(combos), categories: map(categories) };
  }

  async listCashSessions(from: string | undefined, to: string | undefined, limit: number, offset: number) {
    const range = resolveDateRange(from, to);
    const rows = await this.db
      .selectFrom('cash_register_sessions')
      .selectAll()
      .where('opened_at', '>=', range.start)
      .where('opened_at', '<', range.end)
      .orderBy('opened_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();
    return { limit, offset, sessions: rows.map(toCashSessionResponse) };
  }
}
