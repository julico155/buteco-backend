import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, sql, Transaction } from 'kysely';
import { AppConfig } from '../config/configuration';
import { KYSELY } from '../database/database.module';
import {
  Database,
  OrderChannel,
  OrderDeliveryType,
  OrderPaymentMethod,
  OrderPaymentStatus,
  OrderPromotionComponentSnapshot,
  OrderStatus,
  QrScope,
} from '../database/types';
import {
  DomainException,
  InvalidStateTransitionError,
  NotFoundDomainError,
  ProductUnavailableError,
  PromotionUnavailableError,
  StoreClosedError,
  ValidationError,
} from '../common/exceptions/domain-exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import {
  applyOutOfHoursPolicy,
  businessDayKey,
  checkoutGateAt,
  lateRequestExpiryFor,
} from '../common/time/service-window';
import { OperationalSettingsService } from '../operational-settings/operational-settings.service';
import { PaymentOptionsService } from '../payment-options/payment-options.service';
import { assertMinimumOrder, minimumsFrom } from '../operational-settings/order-minimum.rules';
import {
  assertChannelEnabled,
  assertServiceTypeEnabled,
  channelAvailability,
  serviceAvailability,
} from '../operational-settings/availability.rules';
import { DeliveryService, OrderQuoteResponse } from '../delivery/delivery.service';
import { NotificationsOutService } from '../notifications-out/notifications-out.service';
import { CashRegisterService } from '../cash-register/cash-register.service';
import { QrPaymentsService } from '../bank-qr/qr-payments.service';
import { DeliveryNoticesService } from '../delivery-notices/delivery-notices.service';
import type { WhatsappMessagePayload } from '../gateway-client/gateway-client.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { normalizePhone } from '../customers/normalize-phone';
import { requiresPaymentBeforeHandover } from './payment-gate';
import { decideLocationAttach, LocationAttachDecision } from './location-attach';
import { buildQrConfirmationContext, qrAmountFor } from './qr-confirmation-context';

export interface OrderItemResponse {
  productId: string;
  productCodeSnapshot: string;
  productNameSnapshot: string;
  unitPriceSnapshot: number;
  quantity: number;
  subtotal: number;
  excludedComplements: string[];
  /** Ronda de la cuenta de mesa en la que se agregó (1 en pedidos normales). */
  roundNumber: number;
}

export interface OrderPromotionResponse {
  promotionId: string | null;
  promotionNameSnapshot: string;
  promoPriceSnapshot: number;
  comboQuantity: number;
  subtotal: number;
  componentsSnapshot: OrderPromotionComponentSnapshot[];
  roundNumber: number;
}

export interface OrderResponse {
  id: string;
  orderNumber: string;
  customerId: string | null;
  channel: string;
  customerName: string;
  deliveryType: string;
  /** Mesa de la cuenta (solo dine_in abierto desde una mesa). */
  tableId: string | null;
  /** "Pidió la cuenta" (cuenta de mesa). */
  billRequestedAt: string | null;
  paymentMethod: string;
  /** Solo delivery pagado por QR: 'food_only' (el repartidor cobra el envío) o 'food_and_delivery' (el QR cubre todo). */
  qrScope: QrScope | null;
  paymentStatus: string;
  status: string;
  notes: string | null;
  subtotalAmount: number;
  deliveryBaseAmount: number;
  deliverySurchargeAmount: number;
  totalAmount: number;
  deliveryQuoteStatus: string | null;
  deliveryDistanceMeters: number | null;
  cashConfirmedAt: string | null;
  /** Solo con paymentMethod='split'. */
  splitCashAmount: number | null;
  splitQrAmount: number | null;
  splitCashConfirmedAt: string | null;
  statusUpdatedBy: string | null;
  /** Repartidor asignado (solo pedidos de delivery ya aceptados). */
  deliveryDriverName: string | null;
  deliveryAcceptedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  /**
   * Última escritura de la fila, no solo cambios de status — también se
   * toca al agregar una nota (`addNote`), adjuntar ubicación
   * (`applyLocationLocked`) o armar un split (`setSplitPayment`). Para "hace
   * cuánto cambió de status" de verdad, usar junto con `statusUpdatedBy`
   * (ambos se escriben siempre juntos en `updateStatus`) y no solo.
   */
  updatedAt: string;
  items: OrderItemResponse[];
  /** Combos vendidos. `items` solo trae los productos sueltos, así que sin esto el ticket y el tablero de cocina quedan incompletos. */
  promotions: OrderPromotionResponse[];
}

export interface LateOrderRequestAcceptedResponse {
  requestId: string;
  requestNumber: string;
  status: 'pending';
  subtotalAmount: number;
  expiresAt: string;
}

export type CreateOrderOutcome =
  | { httpStatus: 200 | 201; body: OrderResponse }
  | { httpStatus: 202; body: LateOrderRequestAcceptedResponse };

export function buildLateOrderTelegramAction(action: 'accept' | 'reject', id: string): string {
  return `late_order.${action}:${id}`;
}

export interface CheckoutCartInput {
  customerId: string | null;
  channel: OrderChannel;
  customerName: string;
  deliveryType: OrderDeliveryType;
  paymentMethod: OrderPaymentMethod;
  /** Qué cubre el QR en un delivery; si falta, se resuelve según qué opciones estén habilitadas. */
  qrScope?: QrScope | null;
  /**
   * Solo lo pasa LateOrderRequestsService.accept(): la solicitud ya se validó
   * al crearse (forma de pago, pedido mínimo) y el cliente ya tiene la promesa —
   * cambiar la configuración después no debe rechazar un pedido que el local
   * ya aceptó.
   */
  skipAvailabilityChecks?: boolean;
  /** Pedido ya cobrado fuera del sistema (canal `external`): nace `paid`. */
  settledExternally?: boolean;
  notes: string | null;
  items: { productId: string; quantity: number; excludedComplements?: string[] }[];
  promotions: { promotionId: string; quantity: number; revision: number }[];
  /** Solo lo pasa LateOrderRequestsService.accept() — un pedido normal nace sin caja, se vincula recién al cobrarse. */
  registerSessionId?: string | null;
}

/**
 * No hay pantalla de cocina: la comanda sale impresa y el cajero recibe el
 * pedido listo por la ventanilla. Por eso un pedido confirmado se cierra en un
 * solo paso: recojo y mesa -> `delivered` (entregado), delivery ->
 * `out_for_delivery` (despachado; no hay confirmación de entrega).
 * `preparing` y `ready` ya no se alcanzan: solo quedan como origen para
 * pedidos que ya estaban en esos estados antes del cambio.
 */
const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ['awaiting_location', 'confirmed', 'cancelled'],
  awaiting_location: ['confirmed', 'cancelled'],
  // Cuenta de mesa abierta: se cierra por `TableAccountsService`, no por PATCH /status.
  open: [],
  confirmed: ['out_for_delivery', 'delivered', 'cancelled'],
  preparing: ['out_for_delivery', 'delivered', 'cancelled'],
  ready: ['out_for_delivery', 'delivered', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

/** Delivery se despacha; recojo y mesa se entregan. */
function handoverStatusFor(deliveryType: OrderDeliveryType): OrderStatus {
  return deliveryType === 'delivery' ? 'out_for_delivery' : 'delivered';
}

/**
 * Corazón del sistema. Porta `create_order_web_v5` (el sistema anterior,
 * `0029_promotions.sql`) al esquema nuevo: sin `menu_sessions` (el
 * `Idempotency-Key` genérico reemplaza sesión+fingerprint) y con
 * products/categories en vez de menu_items con enum.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly idempotency: IdempotencyService,
    private readonly operationalSettings: OperationalSettingsService,
    private readonly deliveryService: DeliveryService,
    private readonly notifications: NotificationsOutService,
    private readonly cashRegister: CashRegisterService,
    private readonly qrPayments: QrPaymentsService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly deliveryNotices: DeliveryNoticesService,
    private readonly paymentOptions: PaymentOptionsService,
  ) {}

  async findById(id: string): Promise<OrderResponse> {
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', id);
    const { items, promotions } = await loadOrderLines(this.db, id);
    return toOrderResponse(order, items, promotions);
  }

  async findMany(filter: {
    customerId?: string;
    status?: OrderStatus;
    deliveryType?: OrderDeliveryType;
    paymentStatus?: OrderPaymentStatus;
    channel?: OrderChannel;
    limit?: number;
    offset?: number;
  }): Promise<OrderResponse[]> {
    let query = this.db.selectFrom('orders').selectAll();
    if (filter.channel) query = query.where('channel', '=', filter.channel);
    if (filter.customerId) query = query.where('customer_id', '=', filter.customerId);
    if (filter.status) query = query.where('status', '=', filter.status);
    if (filter.deliveryType) query = query.where('delivery_type', '=', filter.deliveryType);
    if (filter.paymentStatus) query = query.where('payment_status', '=', filter.paymentStatus);
    const orders = await query
      .orderBy('created_at', 'desc')
      .limit(Math.min(filter.limit ?? 50, 200))
      .offset(filter.offset ?? 0)
      .execute();
    if (orders.length === 0) return [];

    const orderIds = orders.map((o) => o.id);
    const items = await this.db
      .selectFrom('order_items')
      .selectAll()
      .where('order_id', 'in', orderIds)
      .execute();
    const promotions = await this.db
      .selectFrom('order_promotions')
      .selectAll()
      .where('order_id', 'in', orderIds)
      .execute();

    const itemsByOrder = groupByOrderId(items);
    const promotionsByOrder = groupByOrderId(promotions);
    return orders.map((order) =>
      toOrderResponse(
        order,
        itemsByOrder.get(order.id) ?? [],
        promotionsByOrder.get(order.id) ?? [],
      ),
    );
  }

  /**
   * POST /orders. Gate de horario evaluado ANTES que todo lo demás
   * (invariante 7): afuera del margen horario -> 409 cerrado; adentro, la
   * caja decide (ver checkoutGateAt) -> sin caja abierta, 202 +
   * late_order_requests (no consume la Idempotency-Key genérica, usa la
   * suya propia como columna única, igual que delivery_quote_requests).
   * `bypassHoursGate` solo se honra para channel='pos' (decisión de
   * producto — POS puede vender fuera del horario de delivery de WhatsApp,
   * y de la caja: el mostrador vende sin necesitar sesión de caja abierta
   * para simplemente CREAR el pedido, aunque cobrarlo sí la va a exigir).
   *
   * Para channel='web' existe un segundo bypass, pensado solo para probar
   * fuera de horario sin abrir al público: NUNCA es un flag que manda el
   * cliente (sería un hueco de seguridad para cualquier visitante) — se
   * resuelve server-side contra `AI_TEST_PHONES` (config `aiTestPhones`),
   * mirando el teléfono real del customerId ya existente. Vacía por
   * defecto = cero cambio de comportamiento. No toca business_opens_hour/
   * closesHour ni el gate de caja abierta para pagar.
   */
  async create(
    dto: CreateOrderDto,
    idempotencyKey: string,
    apiClient: string,
  ): Promise<CreateOrderOutcome> {
    const settings = await this.operationalSettings.getRow();
    // Antes que el horario: un canal o servicio apagado no es "cerrado ahora".
    assertChannelEnabled(channelAvailability(settings), dto.channel);
    assertServiceTypeEnabled(serviceAvailability(settings), dto.deliveryType);
    // `external` reporta ventas de un POS ajeno: ya sucedieron, por eso no pasan
    // por el gate de horario ni por la caja, nacen pagadas, y no hay delivery
    // (el reparto necesita ubicación, cotización y repartidor de este sistema).
    if (dto.channel === 'external' && dto.deliveryType === 'delivery') {
      throw new ValidationError('El canal external no admite pedidos de delivery.');
    }
    // El consumo en el local siempre tiene mesa: se abre desde la mesa
    // (POST /tables/:id/account), no con un pedido suelto.
    if (dto.channel !== 'external' && dto.deliveryType === 'dine_in') {
      throw new ValidationError(
        'Los pedidos de mesa se abren desde la mesa: POST /tables/:id/account.',
      );
    }
    const now = new Date();
    const bypassAllowed =
      dto.channel === 'external' ||
      (dto.bypassHoursGate === true && dto.channel === 'pos') ||
      (dto.channel === 'web' && (await this.isAiTestCustomer(dto.customerId)));
    // Sin caja obligatoria, "caja cerrada" no es un motivo para encolar.
    const registerOk =
      settings.require_open_register === false || (await this.cashRegister.isOpen());
    const gate = bypassAllowed
      ? ({ gate: 'proceed' } as const)
      : applyOutOfHoursPolicy(
          checkoutGateAt(
            now,
            { opensHour: settings.business_opens_hour, closesHour: settings.business_closes_hour },
            registerOk,
          ),
          settings.out_of_hours_policy ?? 'queue',
        );

    if (gate.gate === 'closed') {
      throw new StoreClosedError();
    }

    if (gate.gate === 'late_review') {
      const body = await this.createLateOrderRequest(dto, idempotencyKey, now);
      return { httpStatus: 202, body };
    }

    const outcome = await this.idempotency.run({
      apiClient,
      endpoint: 'POST /orders',
      idempotencyKey,
      requestBody: dto,
      execute: (trx) => this.executeCreateOrder(trx, dto),
    });

    // Fuera de la transacción a propósito: notifyOrderCreated hace una
    // lectura propia del pedido (otra conexión) y, para QR, una llamada HTTP
    // al banco — si corriera adentro del trx de arriba, la lectura no vería
    // el INSERT todavía sin commitear ("order no existe"), y la llamada
    // externa quedaría sosteniendo la transacción abierta. Solo en una
    // creación real (no en una respuesta cacheada de un reintento).
    if (outcome.created) {
      this.notifyOrderCreated(outcome.body).catch((error: Error) =>
        this.logger.warn(`notifyOrderCreated falló para ${outcome.body.id}: ${error.message}`),
      );
    }

    return { httpStatus: outcome.created ? 201 : 200, body: outcome.body };
  }

  /**
   * Bypass de horario SOLO para pruebas web (ver comentario de `create()`).
   * Sale `false` de una si no hay allowlist configurada o no vino
   * customerId — así el camino normal (sin AI_TEST_PHONES seteada) nunca
   * paga el costo de esta consulta extra.
   */
  private async isAiTestCustomer(customerId: string | undefined): Promise<boolean> {
    const allowlist = this.config.get('aiTestPhones', { infer: true });
    if (allowlist.length === 0 || !customerId) return false;

    const customer = await this.db
      .selectFrom('customers')
      .select('phone')
      .where('id', '=', customerId)
      .executeTakeFirst();
    if (!customer?.phone) return false;

    return allowlist.includes(normalizePhone(customer.phone, { assumeInternational: true }));
  }

  /** Público: también lo dispara `OrderReplacementService` tras crear el pedido de reemplazo. */
  async notifyOrderCreated(order: OrderResponse): Promise<void> {
    // Un pedido `external` ya se cobró y se atendió afuera: no hay QR ni avisos.
    if (order.channel === 'external') return;
    if (!order.customerId) return;

    // Delivery: UNA sola solicitud (reason + orderNumber) — Central solo
    // entrega los datos, el agente arma el copy combinado ("recibimos tu
    // pedido" + "mandanos tu ubicación", ver docs/gateway-integration.md).
    // No mandamos order_received aparte: sería un segundo mensaje redundante.
    if (order.status === 'awaiting_location') {
      try {
        await this.sendLocationRequest(order.id, order.customerId, order.orderNumber);
      } catch (error) {
        this.logger.warn(
          `No se pudo notificar location_request para ${order.id}: ${(error as Error).message}`,
        );
      }
      return;
    }

    // Pickup y mesa no esperan nada más de una — a esos sí les llega
    // order_received, y de una el QR (ver sendQrConfirmation).
    try {
      await this.notifications.notifyNow({
        channel: 'whatsapp',
        kind: 'order_received',
        targetRef: order.id,
        payload: {
          customerId: order.customerId,
          messageType: 'order_received',
          context: {
            orderNumber: order.orderNumber,
            deliveryType: order.deliveryType as 'delivery' | 'pickup' | 'dine_in',
          },
        },
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo notificar order_received para ${order.id}: ${(error as Error).message}`,
      );
    }

    await this.sendQrConfirmation(order);
  }

  /**
   * Avisa el total final del pedido — QR real del banco si paymentMethod es
   * 'qr', o el aviso de cobro en efectivo contra entrega si es 'cash'. Se
   * llama solo cuando el pedido ya tiene su total final: en la creación
   * misma para pickup/mesa (no esperan nada más), y recién tras cotizar para
   * delivery (ver `attachLocation` y `AgentLocationsService`) — mandarlo
   * antes cobraría/informaría un total que todavía puede cambiar con la
   * ubicación.
   */
  private async sendQrConfirmation(order: OrderResponse): Promise<void> {
    if (!order.customerId) return;

    // Todo efectivo (comida + envío) — nunca hay QR que generar, el aviso es
    // directo con el total ya conocido (recién cotizado, si es delivery).
    if (order.paymentMethod === 'cash') {
      try {
        await this.notifications.notifyNow({
          channel: 'whatsapp',
          kind: 'cash_on_delivery_confirmation',
          targetRef: order.id,
          payload: {
            customerId: order.customerId,
            messageType: 'cash_on_delivery_confirmation',
            context: {
              orderNumber: order.orderNumber,
              deliveryType: order.deliveryType as 'delivery' | 'pickup' | 'dine_in',
              subtotalAmount: order.subtotalAmount,
              deliveryBaseAmount: order.deliveryBaseAmount,
              deliverySurchargeAmount: order.deliverySurchargeAmount,
              deliveryAmount: order.deliveryBaseAmount + order.deliverySurchargeAmount,
              totalAmount: order.totalAmount,
            },
          },
        });
      } catch (error) {
        this.logger.warn(
          `No se pudo notificar cash_on_delivery_confirmation para ${order.id}: ${(error as Error).message}`,
        );
      }
      return;
    }

    // Central solo entrega el desglose (ver buildQrConfirmationContext); el
    // agente arma el copy. Si el banco falla no se rompe la creación del
    // pedido: se avisa `qr_unavailable` una sola vez (kind+target únicos) y
    // `retryPendingQrCharges` lo reintenta hasta que el pedido venza.
    const posManualMode =
      order.channel === 'pos' && this.config.get('posQrMode', { infer: true }) === 'manual';

    if (order.paymentMethod !== 'qr' || posManualMode) return;

    let payload: WhatsappMessagePayload;
    try {
      const charge = await this.qrPayments.generateForOrder(order.id);
      payload = {
        customerId: order.customerId,
        messageType: 'qr_confirmation',
        imageUrl: charge.qrImageUrl,
        context: buildQrConfirmationContext(order),
      };
    } catch (error) {
      this.logger.warn(
        `No se pudo generar el QR real para ${order.id}, se reintenta: ${(error as Error).message}`,
      );
      try {
        await this.notifications.notifyNow({
          channel: 'whatsapp',
          kind: 'qr_unavailable',
          targetRef: order.id,
          payload: {
            customerId: order.customerId,
            messageType: 'qr_unavailable',
            context: {
              orderNumber: order.orderNumber,
              qrAmount: qrAmountFor(order),
              expiresInMinutes: this.config.get('unpaidOrderTtlMinutes', { infer: true }),
            },
          },
        });
      } catch (notifyError) {
        this.logger.warn(
          `No se pudo notificar qr_unavailable para ${order.id}: ${(notifyError as Error).message}`,
        );
      }
      return;
    }
    try {
      await this.notifications.notifyNow({
        channel: 'whatsapp',
        kind: 'qr_confirmation',
        targetRef: order.id,
        payload,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo notificar qr_confirmation para ${order.id}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Dispara el aviso de cobro (QR o efectivo) recién cotizado: lo llaman
   * `attachLocation` y `AgentLocationsService` fuera de su transacción (mismo
   * motivo que `notifyOrderCreated` — la llamada al banco no puede sostener
   * el trx abierto), y solo cuando `quoteForOrderInTransaction`/
   * `setManualQuote` acaban de congelar el total (`result === 'applied'`),
   * nunca en un replay. De paso, único punto que cubre a los dos callers para
   * avisarle al grupo de delivery un pedido en efectivo recién cotizado —
   * `notifyConfirmed` no hace nada si el pedido no es cash/paid, así que para
   * QR este llamado es un no-op idéntico al de siempre (recién pagado avisa
   * desde `payment-attempts.service.ts`).
   */
  async sendQrConfirmationAfterQuote(orderId: string): Promise<void> {
    const order = await this.findById(orderId);
    await this.sendQrConfirmation(order);
    await this.deliveryNotices.notifyConfirmed(orderId);
  }

  /**
   * order_number reinicia con cada apertura de caja (no cada día calendario
   * — el turno cruza medianoche), así que se ancla a la sesión de caja más
   * reciente por `opened_at`, esté abierta o ya cerrada: los pedidos creados
   * en el hueco entre un cierre y la siguiente apertura siguen sumando al
   * contador de la sesión anterior, y recién el próximo "abrir caja" lo
   * vuelve a poner en 1. El incremento atómico (`UPDATE ... RETURNING`)
   * dentro de la misma transacción del pedido serializa contra cualquier
   * otro pedido creándose al mismo tiempo — nunca dos pedidos de la misma
   * sesión con el mismo número.
   */
  async assignOrderNumber(
    trx: Transaction<Database>,
  ): Promise<{ orderNumber: string; numberingSessionId: string | null }> {
    const settings = await trx
      .selectFrom('operational_settings')
      .select(['require_open_register', 'business_closes_hour'])
      .where('id', '=', true)
      .executeTakeFirst();
    if (settings && settings.require_open_register === false) {
      // Sin caja que ancle la numeración: un contador por día de negocio,
      // incrementado atómicamente (upsert) dentro de la transacción del pedido.
      const day = businessDayKey(new Date(), settings.business_closes_hour);
      const counter = await sql<{ last_number: number }>`
        insert into order_day_counters (day, last_number) values (${day}::date, 1)
        on conflict (day) do update
          set last_number = order_day_counters.last_number + 1, updated_at = now()
        returning last_number
      `.execute(trx);
      const n = counter.rows[0].last_number;
      return { orderNumber: `ORD-${String(n).padStart(4, '0')}`, numberingSessionId: null };
    }

    const latestSession = await trx
      .selectFrom('cash_register_sessions')
      .select('id')
      .orderBy('opened_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    if (!latestSession) {
      // Caso borde: todavía nunca se abrió una caja (arranque del local).
      // Cae al viejo contador global, sin sesión que lo ancle.
      const fallback = await sql<{ nextval: string }>`
        select nextval('order_number_seq') as nextval
      `.execute(trx);
      const n = Number(fallback.rows[0].nextval);
      return { orderNumber: `ORD-${String(n).padStart(4, '0')}`, numberingSessionId: null };
    }

    const updated = await trx
      .updateTable('cash_register_sessions')
      .set({ next_order_number: sql`next_order_number + 1` })
      .where('id', '=', latestSession.id)
      .returning('next_order_number')
      .executeTakeFirstOrThrow();

    return {
      orderNumber: `ORD-${String(updated.next_order_number).padStart(4, '0')}`,
      numberingSessionId: latestSession.id,
    };
  }

  private async executeCreateOrder(
    trx: Transaction<Database>,
    dto: CreateOrderDto,
  ): Promise<{ status: number; body: OrderResponse }> {
    const order = await this.createOrderInTransaction(trx, {
      customerId: dto.customerId ?? null,
      channel: dto.channel,
      customerName: dto.customerName,
      deliveryType: dto.deliveryType,
      paymentMethod: dto.paymentMethod,
      qrScope: dto.qrScope ?? null,
      // Canal `external`: cobrado afuera. No se valida contra nuestras formas de
      // pago ni el mínimo (no son clientes de este sistema).
      settledExternally: dto.channel === 'external',
      skipAvailabilityChecks: dto.channel === 'external',
      notes: dto.notes ?? null,
      items: dto.items,
      promotions: (dto.promotions ?? []).map((p) => ({
        promotionId: p.promotionId,
        quantity: p.quantity,
        revision: p.revision,
      })),
    });

    return { status: 201, body: order };
  }

  /**
   * Valida un carrito contra el catálogo y lo precia con datos de la base
   * (nada del cliente): disponibilidad, complementos, vigencia de promociones.
   * Lo comparten el checkout normal y las rondas de una cuenta de mesa. Tiene
   * que correr dentro de una transacción: los `for share` solo tienen sentido
   * ahí. No chequea totales mínimos ni carrito vacío (eso es del que llama).
   */
  async priceCart(
    trx: Transaction<Database>,
    items: CheckoutCartInput['items'],
    promotions: CheckoutCartInput['promotions'],
  ) {
    const productIds = items.map((i) => i.productId);
    // Dos líneas del mismo producto son válidas si tienen distinta selección
    // de complementos (ej. "sin cebolla" en una sola unidad) — lo que no
    // vale es repetir exactamente la misma combinación en dos líneas, eso
    // debería ser una sola línea con más quantity.
    const itemLineKeys = items.map((i) => `${i.productId}::${complementsKey(i.excludedComplements)}`);
    if (new Set(itemLineKeys).size !== itemLineKeys.length) {
      throw new ValidationError(
        'El carrito tiene líneas duplicadas (mismo producto y misma selección de complementos). Sumá la cantidad en una sola línea en vez de repetirla.',
      );
    }
    const promotionIds = promotions.map((p) => p.promotionId);
    if (new Set(promotionIds).size !== promotionIds.length) {
      throw new ValidationError('El carrito tiene promociones duplicadas.');
    }

    // El reloj de la base, no el del proceso: la vigencia de promociones se
    // compara contra now() de Postgres, en la misma transacción que escribe.
    const nowRow = await sql<{ now: Date }>`select now() as "now"`.execute(trx);
    const now = nowRow.rows[0].now;

    // Lock de promotions (for share, id ascendente).
    const sortedPromotionIds = [...promotionIds].sort();
    const promotionRows =
      sortedPromotionIds.length > 0
        ? await trx
            .selectFrom('promotions')
            .selectAll()
            .where('id', 'in', sortedPromotionIds)
            .orderBy('id', 'asc')
            .forShare()
            .execute()
        : [];
    const promotionById = new Map(promotionRows.map((p) => [p.id, p]));

    const badPromotionIds = new Set<string>();
    for (const p of promotions) {
      const row = promotionById.get(p.promotionId);
      if (
        !row ||
        row.archived_at !== null ||
        row.is_active !== true ||
        (row.starts_at !== null && new Date(row.starts_at) > now) ||
        (row.ends_at !== null && new Date(row.ends_at) <= now) ||
        row.revision !== p.revision
      ) {
        badPromotionIds.add(p.promotionId);
      }
    }

    // Unión de productos sueltos + componentes de combo, lock for share, id asc.
    const promotionComponents =
      promotionIds.length > 0
        ? await trx
            .selectFrom('promotion_items')
            .selectAll()
            .where('promotion_id', 'in', promotionIds)
            .execute()
        : [];

    const allProductIds = Array.from(
      new Set([...productIds, ...promotionComponents.map((c) => c.product_id)]),
    ).sort();

    const productRows =
      allProductIds.length > 0
        ? await trx
            .selectFrom('products')
            .selectAll()
            .where('id', 'in', allProductIds)
            .orderBy('id', 'asc')
            .forShare()
            .execute()
        : [];
    const productById = new Map(productRows.map((p) => [p.id, p]));

    // Un complemento a excluir tiene que existir en EL PRODUCTO de esa
    // línea puntual — no vale mandar "sin cebolla" para un producto que
    // no tiene cebolla en su lista.
    const itemsWithComplements = items.filter((i) => (i.excludedComplements ?? []).length > 0);
    if (itemsWithComplements.length > 0) {
      const complementRows = await trx
        .selectFrom('product_complements')
        .select(['product_id', 'name'])
        .where(
          'product_id',
          'in',
          itemsWithComplements.map((i) => i.productId),
        )
        .execute();
      const validNamesByProduct = new Map<string, Set<string>>();
      for (const row of complementRows) {
        const set = validNamesByProduct.get(row.product_id) ?? new Set<string>();
        set.add(row.name);
        validNamesByProduct.set(row.product_id, set);
      }
      for (const item of itemsWithComplements) {
        const validNames = validNamesByProduct.get(item.productId) ?? new Set<string>();
        const unknown = (item.excludedComplements ?? []).find((name) => !validNames.has(name));
        if (unknown !== undefined) {
          throw new DomainException(
            'unknown_complement',
            HttpStatus.BAD_REQUEST,
            `El producto no tiene un complemento llamado "${unknown}".`,
            { productId: item.productId, complement: unknown },
          );
        }
      }
    }

    const inactiveProductIds = new Set<string>();
    const soldOutProductIds = new Set<string>();
    for (const id of allProductIds) {
      const row = productById.get(id);
      if (!row || row.is_active !== true) inactiveProductIds.add(id);
      else if (row.is_available !== true) soldOutProductIds.add(id);
    }

    // Rechazos de productos SUELTOS únicamente — un componente caído de un
    // combo tiña la promoción (P1005), no produce un rechazo de producto.
    const inactiveLooseItem = items.find((i) => inactiveProductIds.has(i.productId));
    if (inactiveLooseItem) {
      throw new ProductUnavailableError(inactiveLooseItem.productId, 'inactive');
    }
    const soldOutLooseItemIds = items
      .filter((i) => soldOutProductIds.has(i.productId))
      .map((i) => i.productId);
    if (soldOutLooseItemIds.length > 0) {
      throw new ProductUnavailableError(soldOutLooseItemIds[0], 'sold_out', soldOutLooseItemIds);
    }

    // Promociones con algún componente caído.
    for (const comp of promotionComponents) {
      if (inactiveProductIds.has(comp.product_id) || soldOutProductIds.has(comp.product_id)) {
        badPromotionIds.add(comp.promotion_id);
      }
    }

    // Promociones que ya NO ahorran (regla del dinero revalidada al cobrar).
    const componentsByPromotion = new Map<string, { product_id: string; quantity: number }[]>();
    for (const c of promotionComponents) {
      const list = componentsByPromotion.get(c.promotion_id) ?? [];
      list.push(c);
      componentsByPromotion.set(c.promotion_id, list);
    }
    for (const [promotionId, comps] of componentsByPromotion) {
      const promo = promotionById.get(promotionId);
      if (!promo) continue; // ya está en badPromotionIds por "no encontrada"
      const regularTotal = comps.reduce(
        (sum, c) => sum + Number(productById.get(c.product_id)?.price ?? 0) * c.quantity,
        0,
      );
      if (regularTotal <= Number(promo.promo_price)) badPromotionIds.add(promotionId);
    }

    if (badPromotionIds.size > 0) {
      const list = [...badPromotionIds];
      throw new PromotionUnavailableError(list[0], 'unavailable', list);
    }

    // CÁLCULO. Todo desde la base, nada del cliente.
    let subtotal = 0;
    const itemLines = items.map((i) => {
      const product = productById.get(i.productId)!;
      const lineSubtotal = Number(product.price) * i.quantity;
      subtotal += lineSubtotal;
      return {
        product,
        quantity: i.quantity,
        subtotal: lineSubtotal,
        excludedComplements: i.excludedComplements ?? [],
      };
    });

    const promotionLines = promotions.map((p) => {
      const promo = promotionById.get(p.promotionId)!;
      const lineSubtotal = Number(promo.promo_price) * p.quantity;
      subtotal += lineSubtotal;
      const comps = componentsByPromotion.get(p.promotionId) ?? [];
      const componentsSnapshot = comps.map((c) => {
        const product = productById.get(c.product_id)!;
        return {
          productId: product.id,
          code: product.code,
          name: product.name,
          unitPrice: Number(product.price),
          quantity: c.quantity,
        };
      });
      return { promo, quantity: p.quantity, subtotal: lineSubtotal, componentsSnapshot };
    });

    return { itemLines, promotionLines, subtotal, now };
  }

  /**
   * Núcleo transaccional del checkout, reusado tanto por `create()` como por
   * `LateOrderRequestsService.accept()` (que lo llama dentro de su propia
   * transacción bloqueando la solicitud primero). Nunca se llama fuera de
   * una transacción real: todos los locks (`for share`) solo tienen sentido
   * ahí dentro.
   */
  async createOrderInTransaction(
    trx: Transaction<Database>,
    input: CheckoutCartInput,
  ): Promise<OrderResponse> {
    const items = input.items;
    const promotions = input.promotions;

    if (items.length > 20) {
      throw new ValidationError('El carrito admite como máximo 20 productos sueltos.');
    }
    if (promotions.length > 10) {
      throw new ValidationError('El carrito admite como máximo 10 promociones.');
    }
    if (items.length + promotions.length < 1) {
      throw new ValidationError('El carrito está vacío.');
    }

    const customerName = input.customerName.trim();
    if (!customerName || customerName.length > 100) {
      throw new ValidationError('customerName debe tener entre 1 y 100 caracteres.');
    }

    const notes = input.notes?.trim() || null;
    if (notes && notes.length > 500) {
      throw new ValidationError('notes admite como máximo 500 caracteres.');
    }

    // Antes de bloquear nada: si la forma de pago está apagada, falla rápido.
    const qrScope = input.skipAvailabilityChecks
      ? (input.qrScope ?? null)
      : await this.paymentOptions.resolve(
          {
            serviceType: input.deliveryType,
            paymentMethod: input.paymentMethod,
            qrScope: input.qrScope,
            channel: input.channel,
          },
          trx,
        );

    if (input.customerId) {
      const customer = await trx
        .selectFrom('customers')
        .select('id')
        .where('id', '=', input.customerId)
        .executeTakeFirst();
      if (!customer) throw new NotFoundDomainError('customer', input.customerId);
    }

    const { itemLines, promotionLines, subtotal, now } = await this.priceCart(trx, items, promotions);

    if (subtotal <= 0) {
      throw new ValidationError('El total del pedido debe ser positivo.');
    }
    if (!input.skipAvailabilityChecks) {
      assertMinimumOrder(
        minimumsFrom(await this.operationalSettings.getRow()),
        input.deliveryType,
        subtotal,
      );
    }

    // pickup (para llevar) y dine_in (mesa) no necesitan ubicación ni cotización: nacen confirmados.
    const needsDelivery = input.deliveryType === 'delivery';
    const initialStatus: OrderStatus = needsDelivery ? 'awaiting_location' : 'confirmed';
    const confirmedAt = needsDelivery ? null : now;
    const deliveryPricing = needsDelivery ? ('dynamic' as const) : null;
    const deliveryQuoteStatus = needsDelivery ? ('pending' as const) : null;

    const { orderNumber, numberingSessionId } = await this.assignOrderNumber(trx);

    const orderRow = await trx
      .insertInto('orders')
      .values({
        order_number: orderNumber,
        numbering_session_id: numberingSessionId,
        customer_id: input.customerId,
        channel: input.channel,
        customer_name: customerName,
        delivery_type: input.deliveryType,
        payment_method: input.paymentMethod,
        qr_scope: qrScope,
        notes,
        status: initialStatus,
        subtotal_amount: subtotal.toFixed(2),
        total_amount: subtotal.toFixed(2),
        delivery_pricing: deliveryPricing,
        delivery_quote_status: deliveryQuoteStatus,
        confirmed_at: confirmedAt,
        register_session_id: input.registerSessionId ?? null,
        ...(input.settledExternally ? { payment_status: 'paid' as const } : {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (itemLines.length > 0) {
      await trx
        .insertInto('order_items')
        .values(
          itemLines.map((line) => ({
            order_id: orderRow.id,
            product_id: line.product.id,
            product_code_snapshot: line.product.code,
            product_name_snapshot: line.product.name,
            unit_price_snapshot: line.product.price,
            quantity: line.quantity,
            subtotal: line.subtotal.toFixed(2),
            excluded_complements: line.excludedComplements,
          })),
        )
        .execute();
    }

    if (promotionLines.length > 0) {
      await trx
        .insertInto('order_promotions')
        .values(
          promotionLines.map((line) => ({
            order_id: orderRow.id,
            promotion_id: line.promo.id,
            promotion_name_snapshot: line.promo.name,
            promo_price_snapshot: line.promo.promo_price,
            combo_quantity: line.quantity,
            subtotal: line.subtotal.toFixed(2),
            components_snapshot: JSON.stringify(line.componentsSnapshot),
          })),
        )
        .execute();
    }

    const { items: insertedItems, promotions: insertedPromotions } = await loadOrderLines(
      trx,
      orderRow.id,
    );

    return toOrderResponse(orderRow, insertedItems, insertedPromotions);
  }

  /**
   * Ventana `late_review`: NO se llama a `createOrderInTransaction` — se
   * guarda el carrito crudo para revalidarlo por completo recién al aceptar
   * (`LateOrderRequestsService.accept`). Idempotencia propia por columna
   * única (mismo patrón que `delivery_quote_requests`), no la tabla
   * genérica `idempotency_keys`.
   */
  private async createLateOrderRequest(
    dto: CreateOrderDto,
    idempotencyKey: string,
    now: Date,
  ): Promise<LateOrderRequestAcceptedResponse> {
    const existing = await this.db
      .selectFrom('late_order_requests')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existing) return toLateOrderRequestAcceptedResponse(existing);

    const items = dto.items;
    const promotions = dto.promotions ?? [];
    if (items.length + promotions.length < 1) {
      throw new ValidationError('El carrito está vacío.');
    }

    // Se valida y normaliza acá, al pedirse: al aceptarse ya no se vuelve a mirar.
    const qrScope = await this.paymentOptions.resolve({
      serviceType: dto.deliveryType,
      paymentMethod: dto.paymentMethod,
      qrScope: dto.qrScope,
      channel: dto.channel,
    });

    const productIds = items.map((i) => i.productId);
    const promotionIds = promotions.map((p) => p.promotionId);

    const products =
      productIds.length > 0
        ? await this.db.selectFrom('products').selectAll().where('id', 'in', productIds).execute()
        : [];
    const productById = new Map(products.map((p) => [p.id, p]));

    const promotionRows =
      promotionIds.length > 0
        ? await this.db
            .selectFrom('promotions')
            .selectAll()
            .where('id', 'in', promotionIds)
            .execute()
        : [];
    const promotionById = new Map(promotionRows.map((p) => [p.id, p]));

    // Subtotal informativo (best-effort, con precios de HOY): la validación
    // autoritativa completa se repite entera al aceptar, vía
    // createOrderInTransaction. Un producto/promo que ya no exista no revienta
    // la solicitud — solo no suma al subtotal mostrado; se rechazará como
    // 'order_unavailable' recién al intentar aceptar.
    let subtotal = 0;
    for (const item of items) {
      const product = productById.get(item.productId);
      if (product) subtotal += Number(product.price) * item.quantity;
    }
    for (const p of promotions) {
      const promo = promotionById.get(p.promotionId);
      if (promo) subtotal += Number(promo.promo_price) * p.quantity;
    }
    if (subtotal <= 0) {
      throw new ValidationError('El total del pedido debe ser positivo.');
    }
    // Con el subtotal informativo: al aceptarse no se vuelve a mirar.
    assertMinimumOrder(
      minimumsFrom(await this.operationalSettings.getRow()),
      dto.deliveryType,
      subtotal,
    );

    const expiresAt = lateRequestExpiryFor(
      now,
      this.config.get('lateOrderRequestTtlMinutes', { infer: true }) * 60_000,
    );

    const inserted = await this.db
      .insertInto('late_order_requests')
      .values({
        customer_id: dto.customerId ?? null,
        customer_name: dto.customerName.trim(),
        channel: dto.channel,
        delivery_type: dto.deliveryType,
        payment_method: dto.paymentMethod,
        qr_scope: qrScope,
        notes: dto.notes?.trim() || null,
        items_json: JSON.stringify(items),
        promotions_json: JSON.stringify(promotions),
        subtotal_amount: subtotal.toFixed(2),
        idempotency_key: idempotencyKey,
        expires_at: expiresAt,
      })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) {
      try {
        await this.notifications.notifyNow({
          channel: 'telegram',
          kind: 'late_request_alert',
          targetRef: inserted.id,
          payload: {
            chatRef: 'staff-group',
            text: `Solicitud fuera de horario ${inserted.request_number} — ${inserted.customer_name}, total ${inserted.subtotal_amount}.`,
            buttons: [
              { label: 'Aceptar', action: buildLateOrderTelegramAction('accept', inserted.id) },
              { label: 'Rechazar', action: buildLateOrderTelegramAction('reject', inserted.id) },
            ],
          },
        });
      } catch (error) {
        this.logger.warn(
          `No se pudo avisar al mostrador sobre ${inserted.id}: ${(error as Error).message}`,
        );
      }
      return toLateOrderRequestAcceptedResponse(inserted);
    }

    const winner = await this.db
      .selectFrom('late_order_requests')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirstOrThrow();
    return toLateOrderRequestAcceptedResponse(winner);
  }

  async requestLocation(orderId: string): Promise<void> {
    const order = await this.db
      .selectFrom('orders')
      .select(['id', 'delivery_type', 'customer_id', 'order_number'])
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);
    if (order.delivery_type !== 'delivery') {
      throw new ValidationError('El pedido no es de delivery.');
    }
    if (!order.customer_id) {
      throw new ValidationError('El pedido no tiene un cliente al cual pedirle ubicación.');
    }

    await this.sendLocationRequest(order.id, order.customer_id, order.order_number);
  }

  /**
   * `reason: 'delivery_location'` + `orderNumber`: Central solo entrega
   * datos, el copy final ("recibimos tu pedido" + pedido de ubicación) lo
   * arma el agente (ver docs/gateway-integration.md). Sin try/catch acá
   * adentro a propósito: cada caller decide si el fallo es best-effort
   * (notifyOrderCreated) o debe propagar (requestLocation, reintento manual
   * de staff que necesita saber si falló).
   */
  private async sendLocationRequest(
    orderId: string,
    customerId: string,
    orderNumber: string,
  ): Promise<void> {
    await this.notifications.notifyNow({
      channel: 'whatsapp',
      kind: 'location_request',
      targetRef: orderId,
      payload: { customerId, reason: 'delivery_location', orderNumber },
    });
  }

  /**
   * POST /orders/:id/location. Guarda la ubicación y cotiza en UNA transacción
   * con el pedido bloqueado. Si el pedido ya fue cotizado (o avanzó) y llega
   * una ubicación distinta se rechaza con 409 location_conflict SIN tocar las
   * coordenadas: nunca puede quedar tarifa de la ubicación A con coordenadas
   * de la B.
   */
  async attachLocation(
    orderId: string,
    location: { latitude: number; longitude: number },
  ): Promise<OrderResponse> {
    let quoteJustApplied = false;
    await this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('orders')
        .select([
          'id',
          'delivery_type',
          'status',
          'delivery_quote_status',
          'delivery_latitude',
          'delivery_longitude',
        ])
        .where('id', '=', orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw new NotFoundDomainError('order', orderId);
      if (order.delivery_type !== 'delivery') {
        throw new ValidationError('El pedido no es de delivery.');
      }

      const outcome = await this.applyLocationLocked(trx, order, location);
      if (outcome.decision === 'conflict') {
        throw new DomainException(
          'location_conflict',
          HttpStatus.CONFLICT,
          'El pedido ya tiene una ubicación cotizada distinta; no se modifica.',
          { status: order.status, deliveryQuoteStatus: order.delivery_quote_status },
        );
      }
      quoteJustApplied = outcome.quote?.result === 'applied';
    });
    const result = await this.findById(orderId);
    if (quoteJustApplied) {
      this.sendQrConfirmationAfterQuote(orderId).catch((error: Error) =>
        this.logger.warn(`No se pudo notificar QR tras cotizar ${orderId}: ${error.message}`),
      );
    }
    return result;
  }

  /**
   * Decide y aplica una ubicación sobre un pedido YA bloqueado (FOR UPDATE)
   * dentro de `trx`. Compartido por `attachLocation` y por
   * `POST /internal/agent/locations/attach`. Devuelve la decisión; solo
   * escribe (y cotiza) en 'attach' y 'replace'.
   */
  async applyLocationLocked(
    trx: Transaction<Database>,
    order: {
      id: string;
      status: string;
      delivery_quote_status: string | null;
      delivery_latitude: number | null;
      delivery_longitude: number | null;
    },
    location: { latitude: number; longitude: number },
  ): Promise<{ decision: LocationAttachDecision; quote?: OrderQuoteResponse }> {
    const decision = decideLocationAttach(order, location);

    if (decision === 'not_awaiting') {
      throw new DomainException(
        'order_not_quotable',
        HttpStatus.CONFLICT,
        `El pedido no está esperando ubicación (status=${order.status}).`,
      );
    }
    if (decision === 'conflict' || decision === 'already_attached') return { decision };

    await trx
      .updateTable('orders')
      .set({
        delivery_latitude: location.latitude,
        delivery_longitude: location.longitude,
        updated_at: new Date(),
      })
      .where('id', '=', order.id)
      .execute();
    const quote = await this.deliveryService.quoteForOrderInTransaction(trx, order.id);
    return { decision, quote };
  }

  async addKitchenNote(orderId: string, note: string): Promise<OrderResponse> {
    const order = await this.db
      .selectFrom('orders')
      .select(['id', 'notes'])
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);

    const trimmed = note.trim();
    if (!trimmed) throw new ValidationError('La nota no puede estar vacía.');

    const combined = order.notes ? `${order.notes}\n${trimmed}` : trimmed;
    if (combined.length > 500) {
      throw new ValidationError('Las notas admiten como máximo 500 caracteres en total.');
    }

    const updated = await this.db
      .updateTable('orders')
      .set({ notes: combined, updated_at: new Date() })
      .where('id', '=', orderId)
      .returningAll()
      .executeTakeFirstOrThrow();

    const { items, promotions } = await loadOrderLines(this.db, orderId);
    return toOrderResponse(updated, items, promotions);
  }

  async switchToPickup(orderId: string): Promise<OrderResponse> {
    return this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw new NotFoundDomainError('order', orderId);
      if (order.delivery_type !== 'delivery') {
        throw new ValidationError(`El pedido ya es ${order.delivery_type}, no es un delivery.`);
      }
      assertServiceTypeEnabled(
        serviceAvailability(await this.operationalSettings.getRow()),
        'pickup',
      );
      if (order.delivery_quote_status === 'quoted') {
        throw new DomainException(
          'delivery_already_quoted',
          HttpStatus.CONFLICT,
          'No se puede cambiar a pickup: el delivery ya fue cotizado y confirmado.',
        );
      }

      // El método ya elegido tiene que seguir siendo válido para retiro.
      await this.paymentOptions.resolve(
        { serviceType: 'pickup', paymentMethod: order.payment_method, channel: order.channel },
        trx,
      );

      const totalAmount = Number(order.subtotal_amount);
      const updated = await trx
        .updateTable('orders')
        .set({
          delivery_type: 'pickup',
          qr_scope: null,
          delivery_pricing: null,
          delivery_quote_status: null,
          delivery_distance_meters: null,
          delivery_latitude: null,
          delivery_longitude: null,
          delivery_base_amount: '0',
          delivery_surcharge_amount: '0',
          total_amount: totalAmount.toFixed(2),
          status: 'confirmed',
          confirmed_at: order.confirmed_at ?? new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', orderId)
        .returningAll()
        .executeTakeFirstOrThrow();

      const { items, promotions } = await loadOrderLines(trx, orderId);
      return toOrderResponse(updated, items, promotions);
    });
  }

  /**
   * CAS sobre cash_confirmed_at (invariante 5): el efecto (avisar grupo de
   * delivery, luego al cliente) solo se dispara si ESTA llamada ganó el CAS.
   *
   * Vincula el pedido a la caja abierta en este momento (invariante de
   * caja: la plata se atribuye al turno en que entra de verdad) — salvo que
   * ya venga vinculado (pedido fuera de horario, se etiquetó al aceptarse).
   * Por eso deja de ser un UPDATE suelto y pasa a `SELECT ... FOR UPDATE` +
   * transacción, igual que `switchToPickup`.
   */
  /**
   * POST /orders/:id/split-payment — arma un pago dividido (efectivo + QR)
   * ANTES de confirmar ninguna de las dos patas. Los dos montos los declara
   * el cajero por separado y tienen que sumar EXACTO el total del pedido —
   * nunca se calcula un monto a partir del otro, para que un error de
   * tipeo salte acá y no como una diferencia de caja al cerrar la noche.
   * Solo mientras el pedido sigue `unpaid`: no se puede convertir a split
   * un pedido que ya tiene una pata cobrada por otro método.
   */
  async setSplitPayment(
    orderId: string,
    cashAmount: number,
    qrAmount: number,
  ): Promise<OrderResponse> {
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);
    if (order.payment_status !== 'unpaid') {
      throw new DomainException(
        'order_already_paid',
        HttpStatus.CONFLICT,
        'El pedido ya tiene un pago en curso o confirmado — no se puede dividir ahora.',
      );
    }
    // Sin `channel`: dividir el cobro es una acción presencial del cajero (JWT),
    // sin importar por qué canal entró el pedido.
    await this.paymentOptions.resolve({
      serviceType: order.delivery_type,
      paymentMethod: 'split',
    });

    const total = Number(order.total_amount);
    const sum = Math.round((cashAmount + qrAmount) * 100) / 100;
    if (sum !== Math.round(total * 100) / 100) {
      throw new ValidationError(
        `Efectivo (${cashAmount.toFixed(2)}) + QR (${qrAmount.toFixed(2)}) debe sumar exactamente el total del pedido (${total.toFixed(2)}).`,
      );
    }

    const updated = await this.db
      .updateTable('orders')
      .set({
        payment_method: 'split',
        qr_scope: null,
        split_cash_amount: cashAmount.toFixed(2),
        split_qr_amount: qrAmount.toFixed(2),
        split_cash_confirmed_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', orderId)
      .returningAll()
      .executeTakeFirstOrThrow();

    const { items, promotions } = await loadOrderLines(this.db, updated.id);
    return toOrderResponse(updated, items, promotions);
  }

  /**
   * CAS sobre cash_confirmed_at (invariante 5): el efecto (avisar grupo de
   * delivery, luego al cliente) solo se dispara si ESTA llamada ganó el CAS.
   *
   * Vincula el pedido a la caja abierta en este momento (invariante de
   * caja: la plata se atribuye al turno en que entra de verdad) — salvo que
   * ya venga vinculado (pedido fuera de horario, se etiquetó al aceptarse).
   * Por eso deja de ser un UPDATE suelto y pasa a `SELECT ... FOR UPDATE` +
   * transacción, igual que `switchToPickup`.
   *
   * Con `payment_method='split'` confirma solo la PATA efectivo
   * (`split_cash_confirmed_at`, nunca `cash_confirmed_at` — son campos
   * distintos a propósito, para no confundir "cuánto de esto es 100%
   * efectivo" con "la pata efectivo de un split"). `payment_status` recién
   * pasa a `paid` cuando la pata QR también está `accepted` — si ya lo
   * estaba (llegó primero), acá se completa; si no, el pedido queda
   * `unpaid` hasta que `PaymentAttemptsService.decide()` la confirme.
   */
  async confirmCash(orderId: string): Promise<OrderResponse> {
    const result = await this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw new NotFoundDomainError('order', orderId);
      if (order.payment_method !== 'cash' && order.payment_method !== 'split') {
        throw new ValidationError('El pedido no es de pago en efectivo.');
      }
      const isSplit = order.payment_method === 'split';
      const alreadyConfirmed = isSplit
        ? order.split_cash_confirmed_at !== null
        : order.cash_confirmed_at !== null;
      if (alreadyConfirmed) return null; // ya confirmado, comportamiento idempotente de abajo

      const registerSessionId =
        order.register_session_id ?? (await this.cashRegister.sessionIdForPayment(trx));

      let qrLegAccepted = false;
      if (isSplit) {
        const acceptedQr = await trx
          .selectFrom('payment_attempts')
          .select('id')
          .where('order_id', '=', orderId)
          .where('review_status', '=', 'accepted')
          .executeTakeFirst();
        qrLegAccepted = acceptedQr !== undefined;
      }
      const fullyPaid = !isSplit || qrLegAccepted;

      const row = await trx
        .updateTable('orders')
        .set({
          ...(isSplit ? { split_cash_confirmed_at: new Date() } : { cash_confirmed_at: new Date() }),
          ...(fullyPaid ? { payment_status: 'paid' } : {}),
          register_session_id: registerSessionId,
          updated_at: new Date(),
        })
        .where('id', '=', orderId)
        .returningAll()
        .executeTakeFirstOrThrow();

      return { row, fullyPaid };
    });

    if (!result) {
      const existing = await this.findExistingCashOrder(orderId);
      const { items, promotions } = await loadOrderLines(this.db, existing.id);
      return toOrderResponse(existing, items, promotions);
    }
    const { row: updated, fullyPaid } = result;

    // En un split con la pata QR todavía pendiente, no hay nada "confirmado"
    // que avisarle a nadie todavía — recién cuando decide() complete la otra
    // pata se dispara el aviso de pago aceptado (payment-attempts.service.ts).
    await this.notifyCashPaymentFinalized(updated, fullyPaid);

    const { items, promotions } = await loadOrderLines(this.db, updated.id);
    return toOrderResponse(updated, items, promotions);
  }

  private async notifyCashPaymentFinalized(
    order: {
      id: string;
      order_number: string;
      customer_id: string | null;
      delivery_type: OrderDeliveryType;
    },
    fullyPaid: boolean,
  ): Promise<void> {
    if (!fullyPaid) return;
    try {
      if (order.customer_id) {
        await this.notifications.notifyNow({
          channel: 'whatsapp',
          kind: 'cash_confirmed_customer_notice',
          targetRef: order.id,
          payload: {
            customerId: order.customer_id,
            messageType: 'payment_confirmed',
            context: { orderNumber: order.order_number, deliveryType: order.delivery_type, fullyPaid: true },
          },
        });
      }
    } catch {
      this.logger.warn(`cash_confirmation_notification_failed orderId=${order.id}`);
    }
  }

  /**
   * En un split solo revierte la pata efectivo (`split_cash_confirmed_at`)
   * — nunca toca `register_session_id`, porque la pata QR puede seguir
   * atada a esa sesión de verdad. `payment_status` vuelve a `unpaid`
   * siempre, esté o no la pata QR aceptada: sin las dos patas confirmadas
   * el pedido no está pagado, punto.
   */
  async cancelCash(orderId: string): Promise<OrderResponse> {
    const order = await this.db
      .selectFrom('orders')
      .select(['id', 'payment_method'])
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);
    const isSplit = order.payment_method === 'split';
    if (!isSplit && order.payment_method !== 'cash') {
      throw new ValidationError('El pedido no es de pago en efectivo.');
    }

    const updated = await this.db
      .updateTable('orders')
      .set(
        isSplit
          ? { split_cash_confirmed_at: null, payment_status: 'unpaid', updated_at: new Date() }
          : {
              cash_confirmed_at: null,
              payment_status: 'unpaid',
              register_session_id: null,
              updated_at: new Date(),
            },
      )
      .where('id', '=', orderId)
      .where(isSplit ? 'split_cash_confirmed_at' : 'cash_confirmed_at', 'is not', null)
      .returningAll()
      .executeTakeFirst();

    const result = updated ?? (await this.findExistingCashOrder(orderId));
    const { items, promotions } = await loadOrderLines(this.db, result.id);
    return toOrderResponse(result, items, promotions);
  }

  private async findExistingCashOrder(orderId: string) {
    const existing = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!existing) throw new NotFoundDomainError('order', orderId);
    if (existing.payment_method !== 'cash' && existing.payment_method !== 'split') {
      throw new ValidationError('El pedido no es de pago en efectivo.');
    }
    return existing;
  }

  /**
   * PATCH /orders/:id/status — transición legal + CAS optimista. `updatedBy`
   * es el username del staff autenticado (JWT) — queda guardado en
   * `status_updated_by` para saber quién cerró el pedido.
   *
   * El único cierre manual es entregar (recojo/mesa) o despachar (delivery):
   * ver `ORDER_STATUS_TRANSITIONS`. Ahí se exige el pago: QR y split siempre
   * tienen que estar `paid`; el efectivo no (se cobra al entregar), salvo
   * `cash_prepayment_required` en recojo/mesa.
   */
  async updateStatus(orderId: string, to: OrderStatus, updatedBy: string | null): Promise<OrderResponse> {
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);

    const allowed = ORDER_STATUS_TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(to)) {
      throw new InvalidStateTransitionError('order', order.status, to);
    }

    const expectedHandover = handoverStatusFor(order.delivery_type);
    // Un delivery ya despachado todavía puede pasar a `delivered` (pedidos viejos).
    const isLegacyDelivered = order.status === 'out_for_delivery' && to === 'delivered';
    if ((to === 'out_for_delivery' || to === 'delivered') && to !== expectedHandover && !isLegacyDelivered) {
      throw new DomainException(
        'invalid_handover_status',
        HttpStatus.CONFLICT,
        order.delivery_type === 'delivery'
          ? 'Un pedido de delivery se marca como despachado.'
          : 'Un pedido de recojo o mesa se marca como entregado.',
        { deliveryType: order.delivery_type, to },
      );
    }

    if ((to === 'out_for_delivery' || to === 'delivered') && order.payment_status !== 'paid') {
      // Solo el efectivo presencial depende de la configuración: no se consulta de más.
      const cashPrepaymentRequired =
        order.payment_method === 'cash' && order.delivery_type !== 'delivery'
          ? (await this.operationalSettings.getRow()).cash_prepayment_required
          : false;
      if (
        requiresPaymentBeforeHandover({
          paymentMethod: order.payment_method,
          deliveryType: order.delivery_type,
          cashPrepaymentRequired,
        })
      ) {
        throw new DomainException(
          'payment_required',
          HttpStatus.CONFLICT,
          'El pedido debe estar pagado antes de entregarse o despacharse.',
          { paymentStatus: order.payment_status },
        );
      }
    }

    const updated = await this.db
      .updateTable('orders')
      .set({ status: to, status_updated_by: updatedBy, updated_at: new Date() })
      .where('id', '=', orderId)
      .where('status', '=', order.status)
      .returningAll()
      .executeTakeFirst();

    if (!updated) {
      throw new DomainException(
        'status_conflict',
        HttpStatus.CONFLICT,
        'El estado del pedido cambió antes de aplicar esta transición; reintenta.',
      );
    }

    if (to === 'cancelled' && order.payment_method === 'qr') {
      this.qrPayments
        .cancelForOrder(orderId)
        .catch((error: Error) =>
          this.logger.warn(`No se pudo cancelar el QR bancario de ${orderId}: ${error.message}`),
        );
    }

    const { items, promotions } = await loadOrderLines(this.db, orderId);
    return toOrderResponse(updated, items, promotions);
  }

  /**
   * Reintenta el QR real de los pedidos QR (WhatsApp/web) cuyo primer intento
   * falló: siguen `confirmed`, impagos, sin ningún cobro bancario creado y
   * dentro de su TTL. Lo que pasa después es solo del cron de expiración
   * (`expireUnpaidOrders`): si el banco no vuelve antes, el pedido se cancela
   * y el cliente recibe `order_expired_unpaid`. `minAgeSeconds` evita pisar el
   * primer intento, que todavía puede estar en vuelo. Devuelve cuántos
   * pedidos se intentaron.
   */
  async retryPendingQrCharges(params: {
    ttlMinutes: number;
    minAgeSeconds?: number;
    limit?: number;
  }): Promise<number> {
    const now = Date.now();
    const newest = new Date(now - (params.minAgeSeconds ?? 60) * 1000);
    const oldest = new Date(now - params.ttlMinutes * 60_000);

    const candidates = await this.db
      .selectFrom('orders')
      .select('id')
      .where('payment_method', '=', 'qr')
      .where('payment_status', '=', 'unpaid')
      .where('status', '=', 'confirmed')
      .where('channel', 'in', ['whatsapp', 'web'])
      .where('customer_id', 'is not', null)
      .where('created_at', '<', newest)
      .where('created_at', '>', oldest)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('bank_qr_charges')
              .select('bank_qr_charges.id')
              .whereRef('bank_qr_charges.order_id', '=', 'orders.id'),
          ),
        ),
      )
      .orderBy('created_at')
      .limit(params.limit ?? 20)
      .execute();

    for (const candidate of candidates) {
      try {
        await this.sendQrConfirmation(await this.findById(candidate.id));
      } catch (error) {
        this.logger.warn(`Reintento de QR falló para ${candidate.id}: ${(error as Error).message}`);
      }
    }
    return candidates.length;
  }

  /**
   * Red de seguridad: si el cajero se olvida de marcar un pedido, pasadas
   * `staleHours` horas se cierra solo (delivery -> despachado, recojo y mesa ->
   * entregado) para que listados y reportes no acumulen pedidos abiertos.
   * Solo cierra lo que no está esperando un pago: los QR/split impagos los
   * cancela `expireUnpaidOrders`. Devuelve cuántos cerró.
   */
  async closeStaleOrders(staleHours: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleHours * 3_600_000);
    const open: OrderStatus[] = ['confirmed', 'preparing', 'ready'];
    let closed = 0;
    for (const deliveryType of ['delivery', 'pickup', 'dine_in'] as const) {
      const result = await this.db
        .updateTable('orders')
        .set({ status: handoverStatusFor(deliveryType), status_updated_by: 'system', updated_at: new Date() })
        .where('delivery_type', '=', deliveryType)
        .where('status', 'in', open)
        .where('created_at', '<', cutoff)
        .where((eb) => eb.or([eb('payment_status', '=', 'paid'), eb('payment_method', '=', 'cash')]))
        .executeTakeFirst();
      closed += Number(result.numUpdatedRows);
    }
    return closed;
  }

  /**
   * Cancela los pedidos que siguen sin pagar pasado `ttlMinutes` (WhatsApp y
   * POS por igual): cocina no puede empezar un pedido impago, así que no tiene
   * sentido dejarlos vivos. Se salvan los que ya tienen algo cobrado (una pata
   * de split, un pago bancario detectado) y los que cocina ya aceptó
   * y el efectivo, que se cobra contra entrega y nunca vence. Devuelve cuántos
   * canceló.
   */
  async expireUnpaidOrders(ttlMinutes: number): Promise<number> {
    const cancellable: OrderStatus[] = ['draft', 'awaiting_location', 'confirmed'];
    const cutoff = new Date(Date.now() - ttlMinutes * 60_000);

    const candidates = await this.db
      .selectFrom('orders')
      .select(['id', 'order_number', 'customer_id', 'channel', 'payment_method'])
      .where('status', 'in', cancellable)
      .where('payment_status', '=', 'unpaid')
      // El efectivo no vence: la comanda sale a cocina al crearse y se cobra al
      // entregar. Si nadie lo cierra, lo cierra `closeStaleOrders`.
      .where('payment_method', '!=', 'cash')
      .where('created_at', '<', cutoff)
      .where('cash_confirmed_at', 'is', null)
      .where('split_cash_confirmed_at', 'is', null)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('bank_qr_charges')
              .select('bank_qr_charges.id')
              .whereRef('bank_qr_charges.order_id', '=', 'orders.id')
              .where((cb) =>
                cb.or([
                  cb('bank_qr_charges.status', 'in', ['confirmed', 'paid_unapplied']),
                  cb('bank_qr_charges.paid_detected_at', 'is not', null),
                ]),
              ),
          ),
        ),
      )
      .orderBy('created_at')
      .limit(50)
      .execute();

    let expired = 0;
    for (const order of candidates) {
      try {
        // Última mirada al banco antes de cancelar: si el cliente pagó en el
        // último momento, el polling de 5s todavía podría no haberlo visto.
        if (order.payment_method === 'qr' || order.payment_method === 'split') {
          const pending = await this.db
            .selectFrom('bank_qr_charges')
            .select('qr_id')
            .where('order_id', '=', order.id)
            .where('status', '=', 'pending')
            .execute();
          for (const charge of pending) await this.qrPayments.resolveCharge(charge.qr_id);
        }

        // El WHERE repite las condiciones clave: si el pago entró mientras
        // tanto, no se cancela.
        const cancelled = await this.db
          .updateTable('orders')
          .set({ status: 'cancelled', status_updated_by: 'system', updated_at: new Date() })
          .where('id', '=', order.id)
          .where('payment_status', '=', 'unpaid')
          .where('status', 'in', cancellable)
          .returning('id')
          .executeTakeFirst();
        if (!cancelled) continue;
        expired += 1;

        if (order.payment_method === 'qr' || order.payment_method === 'split') {
          await this.qrPayments.cancelForOrder(order.id);
        }
        if (order.channel === 'whatsapp' && order.customer_id) {
          await this.notifications.notifyNow({
            channel: 'whatsapp',
            kind: 'order_expired_unpaid',
            targetRef: order.id,
            payload: {
              customerId: order.customer_id,
              messageType: 'order_expired_unpaid',
              context: { orderNumber: order.order_number },
            },
          });
        }
      } catch (error) {
        this.logger.warn(
          `No se pudo vencer el pedido ${order.order_number}: ${(error as Error).message}`,
        );
      }
    }
    return expired;
  }
}

function toLateOrderRequestAcceptedResponse(row: {
  id: string;
  request_number: string;
  subtotal_amount: string;
  expires_at: Date | string;
}): LateOrderRequestAcceptedResponse {
  return {
    requestId: row.id,
    requestNumber: row.request_number,
    status: 'pending',
    subtotalAmount: Number(row.subtotal_amount),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** Clave normalizada (orden-insensible) para comparar la selección de complementos excluidos de dos líneas. */
function complementsKey(excluded: string[] | undefined): string {
  return JSON.stringify([...(excluded ?? [])].sort());
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

/** Transaction<Database> extiende Kysely<Database>, así que sirve dentro y fuera de una transacción. */
export async function loadOrderLines(db: Kysely<Database>, orderId: string) {
  const items = await db
    .selectFrom('order_items')
    .selectAll()
    .where('order_id', '=', orderId)
    .where('voided_at', 'is', null)
    .orderBy('round_number')
    .orderBy('created_at')
    .execute();
  const promotions = await db
    .selectFrom('order_promotions')
    .selectAll()
    .where('order_id', '=', orderId)
    .where('voided_at', 'is', null)
    .orderBy('round_number')
    .execute();
  return { items, promotions };
}

export function toOrderResponse(
  order: {
    id: string;
    order_number: string;
    customer_id: string | null;
    channel: string;
    customer_name: string;
    delivery_type: string;
    table_id?: string | null;
    bill_requested_at?: Date | string | null;
    payment_method: string;
    qr_scope?: QrScope | null;
    payment_status: string;
    notes: string | null;
    status: string;
    subtotal_amount: string;
    delivery_base_amount: string;
    delivery_surcharge_amount: string;
    total_amount: string;
    delivery_quote_status: string | null;
    delivery_distance_meters: number | null;
    cash_confirmed_at: Date | string | null;
    split_cash_amount: string | null;
    split_qr_amount: string | null;
    split_cash_confirmed_at: Date | string | null;
    status_updated_by: string | null;
    delivery_driver_name: string | null;
    delivery_accepted_at: Date | string | null;
    delivered_at: Date | string | null;
    created_at: Date | string;
    updated_at: Date | string;
  },
  items: {
    product_id: string;
    product_code_snapshot: string;
    product_name_snapshot: string;
    unit_price_snapshot: string;
    quantity: number;
    subtotal: string;
    excluded_complements: string[];
    round_number?: number;
  }[],
  promotions: {
    round_number?: number;
    promotion_id: string | null;
    promotion_name_snapshot: string;
    promo_price_snapshot: string;
    combo_quantity: number;
    subtotal: string;
    components_snapshot: OrderPromotionComponentSnapshot[];
  }[],
): OrderResponse {
  return {
    id: order.id,
    orderNumber: order.order_number,
    customerId: order.customer_id,
    channel: order.channel,
    customerName: order.customer_name,
    deliveryType: order.delivery_type,
    tableId: order.table_id ?? null,
    billRequestedAt: order.bill_requested_at ? new Date(order.bill_requested_at).toISOString() : null,
    paymentMethod: order.payment_method,
    qrScope: order.qr_scope ?? null,
    paymentStatus: order.payment_status,
    notes: order.notes,
    status: order.status,
    subtotalAmount: Number(order.subtotal_amount),
    deliveryBaseAmount: Number(order.delivery_base_amount),
    deliverySurchargeAmount: Number(order.delivery_surcharge_amount),
    totalAmount: Number(order.total_amount),
    deliveryQuoteStatus: order.delivery_quote_status,
    deliveryDistanceMeters: order.delivery_distance_meters,
    cashConfirmedAt: order.cash_confirmed_at
      ? new Date(order.cash_confirmed_at).toISOString()
      : null,
    splitCashAmount: order.split_cash_amount === null ? null : Number(order.split_cash_amount),
    splitQrAmount: order.split_qr_amount === null ? null : Number(order.split_qr_amount),
    splitCashConfirmedAt: order.split_cash_confirmed_at
      ? new Date(order.split_cash_confirmed_at).toISOString()
      : null,
    statusUpdatedBy: order.status_updated_by,
    deliveryDriverName: order.delivery_driver_name,
    deliveryAcceptedAt: order.delivery_accepted_at
      ? new Date(order.delivery_accepted_at).toISOString()
      : null,
    deliveredAt: order.delivered_at ? new Date(order.delivered_at).toISOString() : null,
    createdAt: new Date(order.created_at).toISOString(),
    updatedAt: new Date(order.updated_at).toISOString(),
    items: items.map((item) => ({
      productId: item.product_id,
      productCodeSnapshot: item.product_code_snapshot,
      productNameSnapshot: item.product_name_snapshot,
      unitPriceSnapshot: Number(item.unit_price_snapshot),
      quantity: item.quantity,
      subtotal: Number(item.subtotal),
      excludedComplements: item.excluded_complements,
      roundNumber: item.round_number ?? 1,
    })),
    promotions: promotions.map((promotion) => ({
      promotionId: promotion.promotion_id,
      promotionNameSnapshot: promotion.promotion_name_snapshot,
      promoPriceSnapshot: Number(promotion.promo_price_snapshot),
      comboQuantity: promotion.combo_quantity,
      subtotal: Number(promotion.subtotal),
      componentsSnapshot: promotion.components_snapshot,
      roundNumber: promotion.round_number ?? 1,
    })),
  };
}
