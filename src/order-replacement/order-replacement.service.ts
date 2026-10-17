import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, Transaction } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database, OrderChannel, OrderDeliveryType, OrderPaymentMethod, OrderStatus } from '../database/types';
import { DomainException, ValidationError } from '../common/exceptions/domain-exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { applyOutOfHoursPolicy, checkoutGateAt } from '../common/time/service-window';
import { OperationalSettingsService } from '../operational-settings/operational-settings.service';
import {
  assertChannelEnabled,
  assertServiceTypeEnabled,
  channelAvailability,
  serviceAvailability,
} from '../operational-settings/availability.rules';
import { CashRegisterService } from '../cash-register/cash-register.service';
import { OrdersService } from '../orders/orders.service';
import { assertWebDeliveryLocation, idempotencyBody } from '../orders/delivery-location';
import {
  checkReplaceable,
  MoneySignalInput,
  ReplaceableReasonCode,
} from '../orders/order-replacement';
import { normalizePhone } from '../customers/normalize-phone';
import { CreateOrderReplacementDto } from './dto/create-order-replacement.dto';
import { AppendOrderNoteDto } from './dto/append-order-note.dto';

export type ReplaceableOrderResult =
  | { result: 'no_order' }
  | { result: 'not_replaceable'; reasonCode: ReplaceableReasonCode }
  | {
      result: 'replaceable';
      orderId: string;
      orderNumber: string;
      status: OrderStatus;
      deliveryType: OrderDeliveryType;
      paymentMethod: OrderPaymentMethod;
      hasLocation: boolean;
      cart: {
        deliveryType: OrderDeliveryType;
        items: { productId: string; quantity: number; excludedComplements: string[] }[];
        promotions: { promotionId: string; quantity: number }[];
      };
    };

export type AppendNoteResult =
  | { result: 'saved' }
  | { result: 'no_order' }
  | { result: 'not_allowed'; reasonCode: ReplaceableReasonCode };

export type CreateReplacementResult =
  | { result: 'replaced'; orderId: string; orderNumber: string; replacedOrderId: string }
  | { result: 'not_found' }
  /** dto.orderId no es el último pedido activo de WhatsApp del cliente — la sesión/CTA quedó vieja. */
  | { result: 'stale_order'; currentOrderId: string }
  | { result: 'not_replaceable'; reasonCode: ReplaceableReasonCode };

const REPLACEMENT_ENDPOINT = 'POST /internal/agent/orders/replacements';
const NOTE_ENDPOINT = 'POST /internal/agent/orders/notes';
const ACTIVE_STATUSES_EXCLUDED: OrderStatus[] = ['cancelled', 'delivered'];

interface ActiveOrderRow {
  id: string;
  order_number: string;
  customer_id: string | null;
  status: OrderStatus;
  payment_status: 'unpaid' | 'pending_review' | 'paid' | 'rejected';
  payment_method: OrderPaymentMethod;
  delivery_type: OrderDeliveryType;
  delivery_latitude: number | null;
  delivery_longitude: number | null;
  notes: string | null;
}

/**
 * FASE 3 — "modificar mi pedido" (replace-not-mutate). Nunca edita las
 * líneas de un pedido existente: crea uno nuevo (reusando
 * OrdersService.createOrderInTransaction, la misma autoridad que
 * POST /orders) y vincula el viejo como reemplazado. El agente nunca manda
 * precios/estado — todo se resuelve y revalida acá, siempre dentro de la
 * transacción que hace el reemplazo (fail-closed ante cualquier señal de
 * pago, ver order-replacement.ts).
 */
@Injectable()
export class OrderReplacementService {
  private readonly logger = new Logger(OrderReplacementService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly idempotency: IdempotencyService,
    private readonly operationalSettings: OperationalSettingsService,
    private readonly cashRegister: CashRegisterService,
    private readonly orders: OrdersService,
  ) {}

  async resolveReplaceable(customerPhoneRaw: string, channel: OrderChannel): Promise<ReplaceableOrderResult> {
    const phone = normalizePhone(customerPhoneRaw, { assumeInternational: true });
    const customer = await this.db
      .selectFrom('customers')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirst();
    if (!customer) return { result: 'no_order' };

    const order = await this.findActiveOrder(this.db, customer.id, channel);
    if (!order) return { result: 'no_order' };

    const check = checkReplaceable(
      { status: order.status, paymentStatus: order.payment_status },
      await this.loadMoneySignals(this.db, order.id),
    );
    if (!check.ok) return { result: 'not_replaceable', reasonCode: check.reasonCode };

    const cart = await this.loadCart(this.db, order.id);
    return {
      result: 'replaceable',
      orderId: order.id,
      orderNumber: order.order_number,
      status: order.status,
      deliveryType: order.delivery_type,
      paymentMethod: order.payment_method,
      hasLocation: order.delivery_latitude !== null && order.delivery_longitude !== null,
      cart: { deliveryType: order.delivery_type, ...cart },
    };
  }

  async appendNote(dto: AppendOrderNoteDto, apiClient: string, channel: OrderChannel): Promise<AppendNoteResult> {
    const phone = normalizePhone(dto.customerPhone, { assumeInternational: true });
    const outcome = await this.idempotency.run<AppendNoteResult>({
      apiClient,
      endpoint: NOTE_ENDPOINT,
      idempotencyKey: dto.sourceMessageId,
      requestBody: { customerPhone: dto.customerPhone, note: dto.note },
      execute: async (trx) => ({ status: 200, body: await this.appendNoteLocked(trx, phone, dto.note, channel) }),
    });
    return outcome.body;
  }

  private async appendNoteLocked(
    trx: Transaction<Database>,
    phone: string,
    note: string,
    channel: OrderChannel,
  ): Promise<AppendNoteResult> {
    const customer = await trx
      .selectFrom('customers')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirst();
    if (!customer) return { result: 'no_order' };

    const order = await this.findActiveOrder(trx, customer.id, channel, { forUpdate: true });
    if (!order) return { result: 'no_order' };

    const check = checkReplaceable(
      { status: order.status, paymentStatus: order.payment_status },
      await this.loadMoneySignals(trx, order.id),
    );
    if (!check.ok) return { result: 'not_allowed', reasonCode: check.reasonCode };

    const trimmed = note.trim();
    if (!trimmed) throw new ValidationError('La nota no puede estar vacía.');
    const combined = order.notes ? `${order.notes}\n${trimmed}` : trimmed;
    if (combined.length > 500) {
      throw new ValidationError('Las notas admiten como máximo 500 caracteres en total.');
    }

    await trx
      .updateTable('orders')
      .set({ notes: combined, updated_at: new Date() })
      .where('id', '=', order.id)
      .execute();
    return { result: 'saved' };
  }

  /**
   * Mismo gate de horario/caja que `OrdersService.create()`. `late_review`
   * no tiene un equivalente de reemplazo en esta fase (no hay "solicitud de
   * reemplazo tardío") — se bloquea con el mismo criterio que `closed`,
   * documentado como límite conocido, no como bug.
   */
  async createReplacement(
    dto: CreateOrderReplacementDto,
    idempotencyKey: string,
    apiClient: string,
    channel: OrderChannel,
  ): Promise<{ httpStatus: number; body: CreateReplacementResult }> {
    const settings = await this.operationalSettings.getRow();
    assertChannelEnabled(channelAvailability(settings), channel);
    assertServiceTypeEnabled(serviceAvailability(settings), dto.deliveryType);
    // Ubicación del checkout web (opcional): solo canal web + delivery; cualquier otro caso se rechaza antes de tocar nada.
    const deliveryLocation = assertWebDeliveryLocation({
      channel,
      deliveryType: dto.deliveryType,
      location: dto.deliveryLocation,
    });
    const registerOk =
      settings.require_open_register === false || (await this.cashRegister.isOpen());
    const gate = applyOutOfHoursPolicy(
      checkoutGateAt(
        new Date(),
        { opensHour: settings.business_opens_hour, closesHour: settings.business_closes_hour },
        registerOk,
      ),
      settings.out_of_hours_policy ?? 'queue',
    );
    if (gate.gate !== 'proceed') {
      throw new DomainException(
        'replacement_unavailable',
        HttpStatus.CONFLICT,
        'Fuera de horario o sin caja abierta: todavía no se puede modificar un pedido en este momento.',
      );
    }

    const phone = normalizePhone(dto.customerPhone, { assumeInternational: true });
    const outcome = await this.idempotency.run<CreateReplacementResult>({
      apiClient,
      endpoint: REPLACEMENT_ENDPOINT,
      idempotencyKey,
      requestBody: idempotencyBody(dto),
      execute: async (trx) => {
        const result = await this.executeReplacement(trx, phone, dto, channel);
        return { status: httpStatusForReplacement(result), body: result };
      },
    });

    if (outcome.created && outcome.body.result === 'replaced') {
      const order = await this.orders.findById(outcome.body.orderId);
      this.orders
        .notifyOrderCreated(order, { locationProvided: deliveryLocation !== null })
        .catch((error: Error) =>
          this.logger.warn(`notifyOrderCreated falló para el reemplazo ${order.id}: ${error.message}`),
        );
    }
    return { httpStatus: outcome.status, body: outcome.body };
  }

  private async executeReplacement(
    trx: Transaction<Database>,
    phone: string,
    dto: CreateOrderReplacementDto,
    channel: OrderChannel,
  ): Promise<CreateReplacementResult> {
    const customer = await trx
      .selectFrom('customers')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirst();
    if (!customer) return { result: 'not_found' };

    // Nunca se busca por dto.orderId directamente — se resuelve el último
    // pedido activo DEL MISMO CANAL del cliente de forma independiente
    // (igual que resolveReplaceable/appendNote) y recién ahí se compara
    // contra lo que mandó el agente. Así un orderId viejo, ajeno, de otro
    // canal (whatsapp vs web), o de POS, nunca puede ser el objetivo de un
    // reemplazo: en el peor caso da stale_order, nunca toca la fila que el
    // cliente pidió. Cruzar canales (seguir desde web un pedido que empezó
    // por WhatsApp) queda fuera de alcance a propósito — ver auditoría.
    const old = await this.findActiveOrder(trx, customer.id, channel, { forUpdate: true });
    if (!old) {
      // No es necesariamente "no tiene pedido": si un replacement concurrente
      // ganó la carrera y ya comiteó, el SELECT ... FOR UPDATE de arriba se
      // bloqueó en la fila vieja y, al desbloquear, Postgres sólo re-evalúa
      // ESA fila puntual (EvalPlanQual) — no vuelve a escanear la tabla, así
      // que nunca ve el pedido nuevo que el ganador acaba de crear. En READ
      // COMMITTED cada sentencia toma su propio snapshot, así que una
      // segunda consulta (sin lock) acá sí lo encuentra si ya existe.
      const maybeNowActive = await this.findActiveOrder(trx, customer.id, channel);
      if (maybeNowActive) return { result: 'stale_order', currentOrderId: maybeNowActive.id };
      return { result: 'not_found' };
    }
    if (old.id !== dto.orderId) return { result: 'stale_order', currentOrderId: old.id };

    const check = checkReplaceable(
      { status: old.status, paymentStatus: old.payment_status },
      await this.loadMoneySignals(trx, old.id),
    );
    if (!check.ok) return { result: 'not_replaceable', reasonCode: check.reasonCode };

    // Cancela el viejo ANTES de crear el nuevo: si createOrderInTransaction
    // rechaza el carrito (producto caído, promo vencida...), el rollback
    // completo de la transacción también deshace esto — el viejo nunca
    // queda cancelado sin un reemplazo real.
    await trx
      .updateTable('orders')
      .set({ status: 'cancelled', status_updated_by: 'system:replacement', updated_at: new Date() })
      .where('id', '=', old.id)
      .execute();

    const created = await this.orders.createOrderInTransaction(trx, {
      customerId: customer.id,
      channel,
      customerName: dto.customerName,
      deliveryType: dto.deliveryType,
      paymentMethod: dto.paymentMethod,
      qrScope: dto.qrScope ?? null,
      // Web con ubicación: el pedido nuevo nace con ESTA ubicación, cotizado en la misma transacción que cancela el viejo.
      deliveryLocation: dto.deliveryLocation
        ? { latitude: dto.deliveryLocation.latitude, longitude: dto.deliveryLocation.longitude }
        : null,
      notes: dto.notes ?? null,
      items: dto.items,
      promotions: (dto.promotions ?? []).map((p) => ({
        promotionId: p.promotionId,
        quantity: p.quantity,
        revision: p.revision,
      })),
    });

    await trx
      .updateTable('orders')
      .set({ replaces_order_id: old.id, updated_at: new Date() })
      .where('id', '=', created.id)
      .execute();
    await trx
      .updateTable('orders')
      .set({ replaced_by_order_id: created.id, updated_at: new Date() })
      .where('id', '=', old.id)
      .execute();

    // Reusa ubicación SOLO para WhatsApp (continuidad: el agente no siempre
    // vuelve a pedir ubicación) y solo si ambos son delivery y el viejo ya
    // la tenía — nunca copia la tarifa: quoteForOrderInTransaction (dentro
    // de applyLocationLocked) la recalcula entera con las reglas vigentes.
    // Para web NO se copia: o bien el checkout manda su ubicación AL CREAR
    // (`dto.deliveryLocation`, ya aplicada y cotizada arriba), o bien la vuelve
    // a pedir y la adjunta él mismo después — si acá ya hubiéramos cotizado
    // con la vieja, esa llamada posterior chocaría con `location_conflict`
    // (ver decideLocationAttach) al traer una ubicación distinta sobre un
    // pedido que ya no está awaiting_location.
    if (
      channel === 'whatsapp' &&
      dto.deliveryType === 'delivery' &&
      old.delivery_type === 'delivery' &&
      old.delivery_latitude !== null &&
      old.delivery_longitude !== null
    ) {
      const freshNew = await trx
        .selectFrom('orders')
        .select(['id', 'status', 'delivery_quote_status', 'delivery_latitude', 'delivery_longitude'])
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      await this.orders.applyLocationLocked(trx, freshNew, {
        latitude: old.delivery_latitude,
        longitude: old.delivery_longitude,
      });
    }

    return { result: 'replaced', orderId: created.id, orderNumber: created.orderNumber, replacedOrderId: old.id };
  }

  /**
   * "Último pedido activo" es SIEMPRE del MISMO canal que el api_client que
   * llama (whatsapp o web, nunca pos — ver AGENT_API_CLIENT_CHANNEL en el
   * controller) — un pedido de otro canal (incluido POS) nunca es candidato
   * acá bajo ningún concepto: ni para leerlo, ni para agregarle una nota, ni
   * para reemplazarlo. No cruza canales a propósito: un pedido que empezó
   * por WhatsApp no se puede "continuar" desde el checkout web ni viceversa
   * (ver auditoría — cruzar canales es una decisión de producto aparte).
   * Estos 3 métodos comparten esta única resolución.
   */
  private async findActiveOrder(
    executor: Kysely<Database>,
    customerId: string,
    channel: OrderChannel,
    opts: { forUpdate?: boolean } = {},
  ): Promise<ActiveOrderRow | undefined> {
    let query = executor
      .selectFrom('orders')
      .select([
        'id',
        'order_number',
        'customer_id',
        'status',
        'payment_status',
        'payment_method',
        'delivery_type',
        'delivery_latitude',
        'delivery_longitude',
        'notes',
      ])
      .where('customer_id', '=', customerId)
      .where('channel', '=', channel)
      .where('status', 'not in', ACTIVE_STATUSES_EXCLUDED)
      .orderBy('created_at', 'desc')
      .limit(1);
    if (opts.forUpdate) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  private async loadMoneySignals(executor: Kysely<Database>, orderId: string): Promise<MoneySignalInput> {
    const [charges, attempts] = await Promise.all([
      executor
        .selectFrom('bank_qr_charges')
        .select(['status', 'paid_detected_at'])
        .where('order_id', '=', orderId)
        .execute(),
      executor
        .selectFrom('payment_attempts')
        .select('review_status')
        .where('order_id', '=', orderId)
        .execute(),
    ]);
    return {
      chargeStatuses: charges.map((c) => c.status),
      attemptStatuses: attempts.map((a) => a.review_status),
      anyPaidDetectedAt: charges.some((c) => c.paid_detected_at !== null),
    };
  }

  /** Solo identificadores + cantidades — nunca precios como autoridad (el cliente los revalida al confirmar). */
  private async loadCart(
    executor: Kysely<Database>,
    orderId: string,
  ): Promise<{
    items: { productId: string; quantity: number; excludedComplements: string[] }[];
    promotions: { promotionId: string; quantity: number }[];
  }> {
    const [items, promotions] = await Promise.all([
      executor
        .selectFrom('order_items')
        .select(['product_id', 'quantity', 'excluded_complements'])
        .where('order_id', '=', orderId)
        .execute(),
      executor
        .selectFrom('order_promotions')
        .select(['promotion_id', 'combo_quantity'])
        .where('order_id', '=', orderId)
        .execute(),
    ]);
    return {
      items: items.map((i) => ({
        productId: i.product_id,
        quantity: i.quantity,
        excludedComplements: i.excluded_complements,
      })),
      promotions: promotions
        .filter((p): p is typeof p & { promotion_id: string } => p.promotion_id !== null)
        .map((p) => ({ promotionId: p.promotion_id, quantity: p.combo_quantity })),
    };
  }
}

function httpStatusForReplacement(result: CreateReplacementResult): number {
  switch (result.result) {
    case 'replaced':
      return HttpStatus.CREATED;
    case 'not_found':
      return HttpStatus.NOT_FOUND;
    case 'stale_order':
    case 'not_replaceable':
      return HttpStatus.CONFLICT;
  }
}
