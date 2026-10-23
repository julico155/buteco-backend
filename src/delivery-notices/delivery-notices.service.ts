import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { AppConfig } from '../config/configuration';
import { KYSELY } from '../database/database.module';
import { Database, OrderPromotionComponentSnapshot } from '../database/types';
import { NotificationsOutService } from '../notifications-out/notifications-out.service';
import { maxPrepMinutes } from '../orders/order-item-options';
import { buildDeliveryNotice, DeliveryNoticeItem, mergeNoticeItems, noticeItemName } from './delivery-notice';

@Injectable()
export class DeliveryNoticesService {
  private readonly logger = new Logger(DeliveryNoticesService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly notifications: NotificationsOutService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Best-effort. Para QR/split, siempre posterior al commit de pago — la
   * elegibilidad se vuelve a comprobar aquí para que una pata QR de un split
   * nunca anuncie un pedido que aún no está completamente pagado. Para
   * payment_method='cash' no hay pago que esperar (se cobra contra entrega):
   * alcanza con que la cotización ya sea definitiva, por eso este método
   * también se llama justo después de cotizar (ver
   * `OrdersService.sendQrConfirmationAfterQuote`), no solo tras el pago.
   */
  async notifyConfirmed(orderId: string): Promise<void> {
    try {
      const order = await this.db
        .selectFrom('orders')
        .leftJoin('customers', 'customers.id', 'orders.customer_id')
        .select([
          'orders.id as id',
          'orders.order_number as order_number',
          'orders.customer_name as customer_name',
          'customers.phone as customer_phone',
          'orders.delivery_type as delivery_type',
          'orders.payment_method as payment_method',
          'orders.payment_status as payment_status',
          'orders.qr_scope as qr_scope',
          'orders.notes as notes',
          'orders.delivery_quote_status as delivery_quote_status',
          'orders.delivery_base_amount as delivery_base_amount',
          'orders.delivery_surcharge_amount as delivery_surcharge_amount',
          'orders.subtotal_amount as subtotal_amount',
          'orders.total_amount as total_amount',
          'orders.delivery_fee_paid as delivery_fee_paid',
          'orders.delivery_latitude as latitude',
          'orders.delivery_longitude as longitude',
          'orders.delivery_distance_meters as distance_meters',
        ])
        .where('orders.id', '=', orderId)
        .executeTakeFirst();

      if (!order) {
        this.logger.warn(`delivery_notice_order_not_found orderId=${orderId}`);
        return;
      }
      if (
        order.delivery_type !== 'delivery' ||
        order.delivery_quote_status !== 'quoted' ||
        (order.payment_method !== 'cash' && order.payment_status !== 'paid') ||
        order.latitude === null ||
        order.longitude === null
      ) {
        return;
      }

      const [orderItems, promotions] = await Promise.all([
        this.db
          .selectFrom('order_items')
          .select(['product_id', 'product_name_snapshot', 'quantity', 'selected_options'])
          .where('order_id', '=', orderId)
          .execute(),
        this.db
          .selectFrom('order_promotions')
          .select(['combo_quantity', 'components_snapshot'])
          .where('order_id', '=', orderId)
          .execute(),
      ]);

      // Personas y tiempo de preparación se leen del catálogo vivo, no de una copia en la línea: son datos descriptivos, no
      // algo que se cobró o se sirvió, así que no hace falta congelarlos.
      const productIds = [
        ...new Set([
          ...orderItems.map((item) => item.product_id),
          ...promotions.flatMap((p) => p.components_snapshot.map((c) => c.productId)),
        ]),
      ];
      const productRows =
        productIds.length > 0
          ? await this.db
              .selectFrom('products')
              .select(['id', 'serves_label', 'prep_minutes'])
              .where('id', 'in', productIds)
              .execute()
          : [];
      const servesById = new Map(productRows.map((product) => [product.id, product.serves_label]));

      const items = mergeNoticeItems([
        ...orderItems.map((item) => ({
          name: noticeItemName(item.product_name_snapshot, servesById.get(item.product_id), item.selected_options),
          quantity: item.quantity,
        })),
        ...promotionItems(promotions),
      ]);
      // Tiempo de preparación: el máximo del pedido (la cocina arma las líneas en paralelo).
      const prepMinutes = maxPrepMinutes(productRows.map((product) => product.prep_minutes));
      const deliveryAmount = Number(order.delivery_base_amount) + Number(order.delivery_surcharge_amount);
      const text = buildDeliveryNotice({
        orderNumber: order.order_number,
        customerName: order.customer_name,
        customerPhone: order.customer_phone ?? '',
        items,
        deliveryAmount,
        subtotalAmount: Number(order.subtotal_amount),
        isCash: order.payment_method === 'cash',
        // Si el QR ya cobró el envío, el repartidor no tiene que cobrarlo.
        deliveryFeePaid: order.qr_scope === 'food_and_delivery' ? true : order.delivery_fee_paid,
        customerNote: order.notes,
        latitude: order.latitude,
        longitude: order.longitude,
        distanceMeters: order.distance_meters,
        prepMinutes,
      });

      await this.notifications.notifyNow({
        channel: 'telegram',
        kind: 'delivery_notice',
        targetRef: orderId,
        payload: { chatRef: this.config.get('deliveryNoticeChatRef', { infer: true }), text },
      });
      this.logger.log(`delivery_notice_queued orderId=${orderId} orderNumber=${order.order_number}`);
    } catch {
      // El payload contiene PII; este log deliberadamente no incluye error, texto ni coordenadas.
      this.logger.warn(`delivery_notice_failed orderId=${orderId}`);
    }
  }
}

function promotionItems(
  promotions: Array<{ combo_quantity: number; components_snapshot: OrderPromotionComponentSnapshot[] }>,
): DeliveryNoticeItem[] {
  const items: DeliveryNoticeItem[] = [];
  for (const promotion of promotions) {
    for (const component of promotion.components_snapshot) {
      items.push({ name: component.name, quantity: component.quantity * promotion.combo_quantity });
    }
  }
  return items;
}
