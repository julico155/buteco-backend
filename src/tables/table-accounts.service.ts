import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely, sql, Transaction } from 'kysely';
import { KYSELY } from '../database/database.module';
import {
  Database,
  OrderPaymentMethod,
  OrderPromotionComponentSnapshot,
  OrderStatus,
} from '../database/types';
import {
  DomainException,
  NotFoundDomainError,
  ValidationError,
} from '../common/exceptions/domain-exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { PaymentOptionsService } from '../payment-options/payment-options.service';
import { QrPaymentsService } from '../bank-qr/qr-payments.service';
import { loadOrderLines, OrderResponse, OrdersService } from '../orders/orders.service';
import { idempotencyBody } from '../orders/delivery-location';
import { itemLineKey } from '../orders/order-item-options';
import { AddRoundDto, CloseAccountDto, OpenAccountDto } from './dto/account.dto';
import { isUniqueViolation } from './tables.service';

/**
 * Canal con el que quedan las cuentas de mesa: las abre el cajero desde el POS.
 * También es el scope de idempotencia de las rondas.
 */
const ACCOUNT_CHANNEL = 'pos' as const;

/** Forma de pago mientras la cuenta está abierta: todavía no se eligió. */
const PLACEHOLDER_PAYMENT_METHOD: OrderPaymentMethod = 'cash';

/** Una línea anulada se sigue mostrando, marcada, pero no suma al total ni sale en la comanda. */
export interface LineVoidInfo {
  voided: boolean;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
}

export interface AccountRound {
  roundNumber: number;
  addedAt: string;
  items: ({
    id: string;
    productName: string;
    quantity: number;
    subtotal: number;
    excludedComplements: string[];
    /** Solo cuando la línea tiene opciones elegidas (p. ej. las carnes de una tabla). */
    selectedOptions?: { groupName: string; optionName: string; priceDelta: number }[];
  } & LineVoidInfo)[];
  promotions: ({
    id: string;
    name: string;
    comboQuantity: number;
    subtotal: number;
    components: OrderPromotionComponentSnapshot[];
  } & LineVoidInfo)[];
}

export interface TableAccountResponse {
  orderId: string;
  orderNumber: string;
  tableId: string;
  tableLabel: string;
  status: OrderStatus;
  paymentStatus: string;
  paymentMethod: string;
  /** Consumo de la cuenta, antes de descontar el adelanto de la reserva. */
  grossAmount: number;
  /** Adelanto de reserva que se descuenta (0 si la mesa no venía de una reserva). */
  depositCreditAmount: number;
  /** Lo que se cobra: consumo menos adelanto. Es el monto que ven QR, efectivo y split. */
  totalAmount: number;
  openedAt: string;
  billRequestedAt: string | null;
  /** Nota del pedido (para la comanda). */
  notes: string | null;
  /** Ronda más reciente: la que el POS imprime al sumar consumo. 0 si todavía no hay consumo. */
  latestRoundNumber: number;
  rounds: AccountRound[];
}

interface LockedTable {
  id: string;
  label: string;
  is_active: boolean;
}

/** Consumo bruto: lo no anulado, antes del adelanto. */
function grossOf(
  items: { subtotal: string; voided_at: Date | string | null }[],
  promotions: { subtotal: string; voided_at: Date | string | null }[],
): number {
  const sum = (lines: { subtotal: string; voided_at: Date | string | null }[]) =>
    lines.filter((l) => l.voided_at === null).reduce((acc, l) => acc + Number(l.subtotal), 0);
  return Math.round((sum(items) + sum(promotions)) * 100) / 100;
}

@Injectable()
export class TableAccountsService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyService,
    private readonly paymentOptions: PaymentOptionsService,
    private readonly qrPayments: QrPaymentsService,
  ) {}

  /** Cuenta viva de la mesa (abierta, o cerrada con cobro pendiente). */
  async getAccount(tableId: string): Promise<TableAccountResponse> {
    const table = await this.requireTable(this.db, tableId);
    const order = await this.findLiveOrder(this.db, tableId);
    if (!order) {
      throw new DomainException(
        'no_open_account',
        HttpStatus.NOT_FOUND,
        'La mesa no tiene una cuenta abierta.',
        { tableId },
      );
    }
    return this.toAccountView(this.db, order, table.label);
  }

  async open(tableId: string, dto: OpenAccountDto, staffUsername: string): Promise<TableAccountResponse> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const opened = await this.openInTransaction(trx, tableId, {
          customerName: dto.customerName,
          notes: dto.notes,
          staffUsername,
        });
        return this.toAccountView(trx, opened.order, opened.tableLabel);
      });
    } catch (error) {
      // Dos aperturas simultáneas: el índice único parcial deja pasar solo una.
      if (isUniqueViolation(error)) throw this.alreadyOpen(tableId);
      throw error;
    }
  }

  /**
   * Abre la cuenta dentro de una transacción ya iniciada. Lo usa tanto el
   * cajero (`open`) como el check-in de una reserva, que además trae el
   * adelanto como crédito: el total de la cuenta lo descuenta desde el inicio.
   */
  async openInTransaction(
    trx: Transaction<Database>,
    tableId: string,
    opts: {
      customerName?: string;
      notes?: string;
      staffUsername: string;
      depositCreditAmount?: number;
    },
  ) {
    const table = await this.requireTable(trx, tableId, true);
    if (!table.is_active) {
      throw new DomainException(
        'table_out_of_service',
        HttpStatus.CONFLICT,
        'La mesa está fuera de servicio.',
        { tableId },
      );
    }
    if (await this.findLiveOrder(trx, tableId)) throw this.alreadyOpen(tableId);

    const { orderNumber, numberingSessionId } = await this.orders.assignOrderNumber(trx);
    const customerName = opts.customerName?.trim() || table.label;
    const order = await trx
      .insertInto('orders')
      .values({
        order_number: orderNumber,
        numbering_session_id: numberingSessionId,
        customer_id: null,
        channel: ACCOUNT_CHANNEL,
        customer_name: customerName.slice(0, 100),
        delivery_type: 'dine_in',
        payment_method: PLACEHOLDER_PAYMENT_METHOD,
        notes: opts.notes?.trim() || null,
        status: 'open',
        subtotal_amount: '0.00',
        total_amount: '0.00',
        deposit_credit_amount: (opts.depositCreditAmount ?? 0).toFixed(2),
        table_id: tableId,
        status_updated_by: opts.staffUsername,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { order, tableLabel: table.label };
  }

  /**
   * Suma una ronda a la cuenta. Precia con la base (como cualquier checkout),
   * recalcula el total de la cuenta y borra "pidió la cuenta". La
   * Idempotency-Key evita sumarla dos veces con un doble toque.
   */
  async addRound(
    tableId: string,
    dto: AddRoundDto,
    idempotencyKey: string,
    staffUsername: string,
  ): Promise<{ created: boolean; body: TableAccountResponse }> {
    const items = dto.items ?? [];
    const promotions = dto.promotions ?? [];
    if (items.length + promotions.length < 1) {
      throw new ValidationError('La ronda está vacía.');
    }
    const lineKeys = items.map(itemLineKey);
    if (new Set(lineKeys).size !== lineKeys.length) {
      throw new ValidationError(
        'La ronda tiene líneas duplicadas (mismo producto, mismos complementos y misma selección de opciones). Sumá la cantidad en una sola línea.',
      );
    }

    const outcome = await this.idempotency.run<TableAccountResponse>({
      apiClient: ACCOUNT_CHANNEL,
      endpoint: `POST /tables/${tableId}/account/rounds`,
      idempotencyKey,
      requestBody: idempotencyBody(dto),
      execute: async (trx) => {
        const table = await this.requireTable(trx, tableId);
        const order = await this.lockLiveOrder(trx, tableId);
        this.assertOpen(order);

        const priced = await this.orders.priceCart(
          trx,
          items.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            excludedComplements: i.excludedComplements,
            selectedOptions: i.selectedOptions,
          })),
          promotions.map((p) => ({
            promotionId: p.promotionId,
            quantity: p.quantity,
            revision: p.revision,
          })),
        );
        if (priced.subtotal <= 0) {
          throw new ValidationError('El total de la ronda debe ser positivo.');
        }

        const roundNumber = await this.nextRoundNumber(trx, order.id);
        if (priced.itemLines.length > 0) {
          await trx
            .insertInto('order_items')
            .values(
              priced.itemLines.map((line) => ({
                order_id: order.id,
                product_id: line.product.id,
                product_code_snapshot: line.product.code,
                product_name_snapshot: line.product.name,
                unit_price_snapshot: line.unitPrice.toFixed(2),
                quantity: line.quantity,
                subtotal: line.subtotal.toFixed(2),
                excluded_complements: line.excludedComplements,
                selected_options: JSON.stringify(line.selectedOptions),
                serves_label_snapshot: line.product.serves_label,
                prep_minutes_snapshot: line.product.prep_minutes,
                round_number: roundNumber,
              })),
            )
            .execute();
        }
        if (priced.promotionLines.length > 0) {
          await trx
            .insertInto('order_promotions')
            .values(
              priced.promotionLines.map((line) => ({
                order_id: order.id,
                promotion_id: line.promo.id,
                promotion_name_snapshot: line.promo.name,
                promo_price_snapshot: line.promo.promo_price,
                combo_quantity: line.quantity,
                subtotal: line.subtotal.toFixed(2),
                components_snapshot: JSON.stringify(line.componentsSnapshot),
                round_number: roundNumber,
              })),
            )
            .execute();
        }

        const updated = await this.recalculateTotals(trx, order.id, {
          status_updated_by: staffUsername,
          bill_requested_at: null,
        });
        return { status: 201, body: await this.toAccountView(trx, updated, table.label) };
      },
    });
    return { created: outcome.created, body: outcome.body };
  }

  /** El mesero avisó que el cliente pidió la cuenta: la mesa pasa a "por cobrar". */
  async requestBill(tableId: string): Promise<TableAccountResponse> {
    return this.db.transaction().execute(async (trx) => {
      const table = await this.requireTable(trx, tableId);
      const order = await this.lockLiveOrder(trx, tableId);
      this.assertOpen(order);
      if (Number(order.total_amount) + Number(order.deposit_credit_amount) <= 0) {
        throw new DomainException(
          'account_empty',
          HttpStatus.CONFLICT,
          'La cuenta no tiene consumo todavía.',
        );
      }
      const updated = await trx
        .updateTable('orders')
        .set({ bill_requested_at: order.bill_requested_at ?? new Date(), updated_at: new Date() })
        .where('id', '=', order.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.toAccountView(trx, updated, table.label);
    });
  }

  /**
   * Cierra la cuenta y elige cómo se cobra.
   *  - efectivo: queda cobrada y entregada en un solo paso (libera la mesa).
   *  - qr: queda cerrada con el cobro pendiente; el POS genera el QR con
   *    POST /orders/:id/qr/generate y la mesa se libera cuando el banco confirma.
   *  - split: queda dividida; cada pata se confirma como en cualquier pedido.
   */
  async close(tableId: string, dto: CloseAccountDto, staffUsername: string): Promise<OrderResponse> {
    await this.requireTable(this.db, tableId);
    const live = await this.findLiveOrder(this.db, tableId);
    if (!live) {
      throw new DomainException('no_open_account', HttpStatus.NOT_FOUND, 'La mesa no tiene una cuenta abierta.');
    }
    this.assertOpen(live);

    const gross = Number(live.total_amount) + Number(live.deposit_credit_amount);
    if (gross <= 0) {
      throw new DomainException('account_empty', HttpStatus.CONFLICT, 'La cuenta no tiene consumo todavía.');
    }
    // El adelanto de la reserva cubrió todo el consumo: no hay nada que cobrar,
    // sin importar la forma de pago elegida.
    const nothingToCollect = Number(live.total_amount) <= 0;
    const paymentMethod: CloseAccountDto['paymentMethod'] = nothingToCollect ? 'cash' : dto.paymentMethod;
    if (paymentMethod === 'split') {
      if (dto.cashAmount === undefined || dto.qrAmount === undefined) {
        throw new ValidationError('El cobro dividido necesita cashAmount y qrAmount.');
      }
    }
    // Falla antes de tocar nada si la forma de pago está apagada.
    if (!nothingToCollect) {
      await this.paymentOptions.resolve({
        serviceType: 'dine_in',
        paymentMethod,
        channel: paymentMethod === 'split' ? undefined : ACCOUNT_CHANNEL,
      });
    }

    const closed = await this.db
      .updateTable('orders')
      .set({
        status: 'confirmed',
        confirmed_at: new Date(),
        payment_method: paymentMethod === 'split' ? PLACEHOLDER_PAYMENT_METHOD : paymentMethod,
        status_updated_by: staffUsername,
        updated_at: new Date(),
      })
      .where('id', '=', live.id)
      .where('status', '=', 'open')
      .returning('id')
      .executeTakeFirst();
    if (!closed) {
      throw new DomainException(
        'status_conflict',
        HttpStatus.CONFLICT,
        'La cuenta cambió antes de cerrarse; reintentá.',
      );
    }

    if (paymentMethod === 'cash') {
      try {
        await this.orders.confirmCash(live.id);
      } catch (error) {
        // Caja cerrada u otro fallo: la cuenta vuelve a quedar abierta, no a medio cerrar.
        await this.revertToOpen(live.id);
        throw error;
      }
      return this.orders.updateStatus(live.id, 'delivered', staffUsername);
    }
    if (paymentMethod === 'split') {
      try {
        return await this.orders.setSplitPayment(live.id, dto.cashAmount!, dto.qrAmount!);
      } catch (error) {
        // Montos que no suman: la cuenta vuelve a quedar abierta para corregir.
        await this.revertToOpen(live.id);
        throw error;
      }
    }
    return this.orders.findById(live.id);
  }

  /**
   * El cliente quiere agregar algo después de pedir el QR: se cancela el cobro
   * pendiente y la cuenta vuelve a estar abierta. No se puede si ya entró plata.
   */
  async reopen(tableId: string, staffUsername: string): Promise<TableAccountResponse> {
    const table = await this.requireTable(this.db, tableId);
    const live = await this.findLiveOrder(this.db, tableId);
    if (!live) {
      throw new DomainException('no_open_account', HttpStatus.NOT_FOUND, 'La mesa no tiene una cuenta abierta.');
    }
    if (live.status === 'open') return this.toAccountView(this.db, live, table.label);

    const moneyIn =
      live.payment_status !== 'unpaid' ||
      live.split_cash_confirmed_at !== null ||
      live.cash_confirmed_at !== null ||
      (await this.hasBankPayment(live.id));
    if (moneyIn) {
      throw new DomainException(
        'payment_in_progress',
        HttpStatus.CONFLICT,
        'La cuenta ya tiene un pago en curso o confirmado: no se puede reabrir.',
        { orderId: live.id },
      );
    }

    await this.qrPayments.cancelForOrder(live.id);
    const reopened = await this.db
      .updateTable('orders')
      .set({
        status: 'open',
        confirmed_at: null,
        payment_method: PLACEHOLDER_PAYMENT_METHOD,
        qr_scope: null,
        split_cash_amount: null,
        split_qr_amount: null,
        split_cash_confirmed_at: null,
        status_updated_by: staffUsername,
        updated_at: new Date(),
      })
      .where('id', '=', live.id)
      .where('status', '=', 'confirmed')
      .returningAll()
      .executeTakeFirst();
    if (!reopened) {
      throw new DomainException(
        'status_conflict',
        HttpStatus.CONFLICT,
        'La cuenta cambió antes de reabrirse; reintentá.',
      );
    }
    return this.toAccountView(this.db, reopened, table.label);
  }

  /**
   * Anula una línea de una cuenta abierta: no se borra, queda marcada con quién
   * y por qué, deja de sumar al total y sigue apareciendo en la cuenta. No
   * imprime nada: se ve al revisar la cuenta.
   */
  async voidLine(
    tableId: string,
    kind: 'item' | 'promotion',
    lineId: string,
    reason: string,
    staffUsername: string,
  ): Promise<TableAccountResponse> {
    const cleanReason = reason.trim();
    if (cleanReason.length < 3) {
      throw new ValidationError('El motivo de la anulación es obligatorio.');
    }
    return this.db.transaction().execute(async (trx) => {
      const table = await this.requireTable(trx, tableId);
      const order = await this.lockLiveOrder(trx, tableId);
      this.assertOpen(order);

      const values = { voided_at: new Date(), voided_by: staffUsername, void_reason: cleanReason };
      const voided =
        kind === 'item'
          ? await trx
              .updateTable('order_items')
              .set(values)
              .where('id', '=', lineId)
              .where('order_id', '=', order.id)
              .where('voided_at', 'is', null)
              .returning('id')
              .executeTakeFirst()
          : await trx
              .updateTable('order_promotions')
              .set(values)
              .where('id', '=', lineId)
              .where('order_id', '=', order.id)
              .where('voided_at', 'is', null)
              .returning('id')
              .executeTakeFirst();
      if (!voided) {
        throw new DomainException(
          'line_not_voidable',
          HttpStatus.NOT_FOUND,
          'La línea no existe en esta cuenta o ya estaba anulada.',
          { lineId },
        );
      }

      const updated = await this.recalculateTotals(trx, order.id, {
        status_updated_by: staffUsername,
        bill_requested_at: order.bill_requested_at,
      });
      return this.toAccountView(trx, updated, table.label);
    });
  }

  /** Solo cuentas sin consumo: una cuenta con plata se cobra (o, más adelante, se anulan sus líneas). */
  async cancel(tableId: string, staffUsername: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.requireTable(trx, tableId);
      const order = await this.lockLiveOrder(trx, tableId);
      this.assertOpen(order);
      const lines = await loadOrderLines(trx, order.id);
      if (lines.items.length + lines.promotions.length > 0) {
        throw new DomainException(
          'account_has_items',
          HttpStatus.CONFLICT,
          'La cuenta tiene consumo: cobrala en vez de cancelarla.',
        );
      }
      await trx
        .updateTable('orders')
        .set({ status: 'cancelled', status_updated_by: staffUsername, updated_at: new Date() })
        .where('id', '=', order.id)
        .execute();
    });
  }

  // ---- internos ----

  /** Deshace el cierre de una cuenta cuyo cobro no pudo arrancar. */
  private async revertToOpen(orderId: string): Promise<void> {
    await this.db
      .updateTable('orders')
      .set({ status: 'open', confirmed_at: null, updated_at: new Date() })
      .where('id', '=', orderId)
      .where('status', '=', 'confirmed')
      .where('payment_status', '=', 'unpaid')
      .execute();
  }

  private alreadyOpen(tableId: string): DomainException {
    return new DomainException(
      'table_already_open',
      HttpStatus.CONFLICT,
      'La mesa ya tiene una cuenta abierta.',
      { tableId },
    );
  }

  private assertOpen(order: { status: OrderStatus; id: string }): void {
    if (order.status !== 'open') {
      throw new DomainException(
        'account_closed',
        HttpStatus.CONFLICT,
        'La cuenta ya está cerrada para cobro: reabrila para agregar consumo.',
        { orderId: order.id },
      );
    }
  }

  private async requireTable(
    db: Kysely<Database>,
    tableId: string,
    forUpdate = false,
  ): Promise<LockedTable> {
    let query = db
      .selectFrom('tables')
      .select(['id', 'label', 'is_active'])
      .where('id', '=', tableId);
    // Serializa aperturas simultáneas sobre la misma mesa.
    if (forUpdate) query = query.forUpdate();
    const table = await query.executeTakeFirst();
    if (!table) throw new NotFoundDomainError('table', tableId);
    return table;
  }

  private async findLiveOrder(db: Kysely<Database>, tableId: string) {
    return db
      .selectFrom('orders')
      .selectAll()
      .where('table_id', '=', tableId)
      .where('status', 'in', ['open', 'confirmed'])
      .where('payment_status', '<>', 'paid')
      .executeTakeFirst();
  }

  private async lockLiveOrder(trx: Transaction<Database>, tableId: string) {
    const order = await trx
      .selectFrom('orders')
      .selectAll()
      .where('table_id', '=', tableId)
      .where('status', 'in', ['open', 'confirmed'])
      .where('payment_status', '<>', 'paid')
      .forUpdate()
      .executeTakeFirst();
    if (!order) {
      throw new DomainException(
        'no_open_account',
        HttpStatus.NOT_FOUND,
        'La mesa no tiene una cuenta abierta.',
        { tableId },
      );
    }
    return order;
  }

  /** Numeración monótona: cuenta también las líneas anuladas para no reusar una ronda. */
  private async nextRoundNumber(trx: Transaction<Database>, orderId: string): Promise<number> {
    const result = await sql<{ max: number | null }>`
      select greatest(
        coalesce((select max(round_number) from order_items where order_id = ${orderId}), 0),
        coalesce((select max(round_number) from order_promotions where order_id = ${orderId}), 0)
      ) as max
    `.execute(trx);
    return (result.rows[0].max ?? 0) + 1;
  }

  /** Total = suma de lo no anulado. Una sola fuente de verdad para la cuenta. */
  private async recalculateTotals(
    trx: Transaction<Database>,
    orderId: string,
    extra: { status_updated_by: string; bill_requested_at: Date | null },
  ) {
    // total = consumo - adelanto (nunca negativo). subtotal y total guardan el
    // neto para que QR, split, efectivo y reportes sigan usando los mismos campos.
    const totals = await sql<{ total: string }>`
      select greatest(0,
        coalesce((select sum(subtotal) from order_items
                  where order_id = ${orderId} and voided_at is null), 0) +
        coalesce((select sum(subtotal) from order_promotions
                  where order_id = ${orderId} and voided_at is null), 0)
        - (select deposit_credit_amount from orders where id = ${orderId})
      )::numeric(10,2) as total
    `.execute(trx);
    const total = totals.rows[0].total;
    return trx
      .updateTable('orders')
      .set({
        subtotal_amount: total,
        total_amount: total,
        status_updated_by: extra.status_updated_by,
        bill_requested_at: extra.bill_requested_at,
        updated_at: new Date(),
      })
      .where('id', '=', orderId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private async hasBankPayment(orderId: string): Promise<boolean> {
    const charge = await this.db
      .selectFrom('bank_qr_charges')
      .select('id')
      .where('order_id', '=', orderId)
      .where((eb) =>
        eb.or([
          eb('status', 'in', ['confirmed', 'paid_unapplied']),
          eb('paid_detected_at', 'is not', null),
        ]),
      )
      .executeTakeFirst();
    return charge !== undefined;
  }

  private async toAccountView(
    db: Kysely<Database>,
    order: {
      id: string;
      order_number: string;
      table_id: string | null;
      status: OrderStatus;
      payment_status: string;
      payment_method: string;
      total_amount: string;
      deposit_credit_amount: string;
      created_at: Date | string;
      bill_requested_at: Date | string | null;
      notes: string | null;
    },
    tableLabel: string,
  ): Promise<TableAccountResponse> {
    // A diferencia de loadOrderLines, acá entran las anuladas: se muestran marcadas.
    const items = await db
      .selectFrom('order_items')
      .selectAll()
      .where('order_id', '=', order.id)
      .orderBy('round_number')
      .orderBy('created_at')
      .execute();
    const promotions = await db
      .selectFrom('order_promotions')
      .selectAll()
      .where('order_id', '=', order.id)
      .orderBy('round_number')
      .execute();

    const voidInfo = (line: {
      voided_at: Date | string | null;
      voided_by: string | null;
      void_reason: string | null;
    }): LineVoidInfo => ({
      voided: line.voided_at !== null,
      voidedAt: line.voided_at ? new Date(line.voided_at).toISOString() : null,
      voidedBy: line.voided_by,
      voidReason: line.void_reason,
    });

    const rounds = new Map<number, AccountRound>();
    const roundOf = (roundNumber: number, addedAt: Date | string): AccountRound => {
      let round = rounds.get(roundNumber);
      if (!round) {
        round = { roundNumber, addedAt: new Date(addedAt).toISOString(), items: [], promotions: [] };
        rounds.set(roundNumber, round);
      }
      return round;
    };
    for (const item of items) {
      roundOf(item.round_number, item.added_at).items.push({
        id: item.id,
        productName: item.product_name_snapshot,
        quantity: item.quantity,
        subtotal: Number(item.subtotal),
        excludedComplements: item.excluded_complements,
        ...(item.selected_options.length > 0
          ? {
              selectedOptions: item.selected_options.map((o) => ({
                groupName: o.groupName,
                optionName: o.optionName,
                priceDelta: o.priceDelta,
              })),
            }
          : {}),
        ...voidInfo(item),
      });
    }
    for (const promotion of promotions) {
      roundOf(promotion.round_number, promotion.added_at).promotions.push({
        id: promotion.id,
        name: promotion.promotion_name_snapshot,
        comboQuantity: promotion.combo_quantity,
        subtotal: Number(promotion.subtotal),
        components: promotion.components_snapshot,
        ...voidInfo(promotion),
      });
    }

    const sortedRounds = [...rounds.values()].sort((a, b) => a.roundNumber - b.roundNumber);

    return {
      orderId: order.id,
      orderNumber: order.order_number,
      tableId: order.table_id as string,
      tableLabel,
      status: order.status,
      paymentStatus: order.payment_status,
      paymentMethod: order.payment_method,
      grossAmount: grossOf(items, promotions),
      depositCreditAmount: Number(order.deposit_credit_amount),
      totalAmount: Number(order.total_amount),
      openedAt: new Date(order.created_at).toISOString(),
      billRequestedAt: order.bill_requested_at ? new Date(order.bill_requested_at).toISOString() : null,
      notes: order.notes,
      latestRoundNumber: sortedRounds.length > 0 ? sortedRounds[sortedRounds.length - 1].roundNumber : 0,
      rounds: sortedRounds,
    };
  }
}
