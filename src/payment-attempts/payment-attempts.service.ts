import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, Transaction } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database, OrderDeliveryType, OrderPaymentStatus, PaymentAttemptReviewStatus } from '../database/types';
import {
  DomainException,
  NotFoundDomainError,
  ValidationError,
} from '../common/exceptions/domain-exception';
import { NotificationsOutService } from '../notifications-out/notifications-out.service';
import { CashRegisterService } from '../cash-register/cash-register.service';
import { DeliveryNoticesService } from '../delivery-notices/delivery-notices.service';

export interface PaymentAttemptResponse {
  id: string;
  orderId: string;
  customerId: string | null;
  openedAt: string;
  openedAs: string;
  reviewStatus: PaymentAttemptReviewStatus;
  reviewedAt: string | null;
}

export interface DecidePaymentAttemptResult {
  attempt: PaymentAttemptResponse;
  /** true solo si ESTA llamada movió pending_review -> decision (invariante 5). */
  won: boolean;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

@Injectable()
export class PaymentAttemptsService {
  private readonly logger = new Logger(PaymentAttemptsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly notifications: NotificationsOutService,
    private readonly cashRegister: CashRegisterService,
    private readonly deliveryNotices: DeliveryNoticesService,
  ) {}

  async findByOrder(orderId: string): Promise<PaymentAttemptResponse[]> {
    const rows = await this.db
      .selectFrom('payment_attempts')
      .selectAll()
      .where('order_id', '=', orderId)
      .orderBy('opened_at', 'desc')
      .execute();
    return rows.map(toResponse);
  }

  /**
   * CAS puro pending_review -> accepted|rejected (invariante 5 y 6 del
   * plan). El UPDATE con WHERE review_status = 'pending_review' es el CAS:
   * bajo carga concurrente, Postgres serializa las dos escrituras y solo una
   * de ellas afecta una fila (won: true) — la otra no encuentra la fila en
   * 'pending_review' y vuelve con won: false, sin volver a evaluar nada.
   *
   * Cuando won es true, en la MISMA transacción se propaga a
   * orders.payment_status ('paid' | 'rejected') — nunca si won es false,
   * para no duplicar el efecto cuando dos decisiones llegan casi al mismo
   * tiempo. El aviso al cliente es best-effort, fuera de la transacción.
   */
  async decide(
    attemptId: string,
    decision: 'accepted' | 'rejected',
  ): Promise<DecidePaymentAttemptResult> {
    const result = await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('payment_attempts')
        .set({ review_status: decision, reviewed_at: new Date(), updated_at: new Date() })
        .where('id', '=', attemptId)
        .where('review_status', '=', 'pending_review')
        .returningAll()
        .executeTakeFirst();

      if (!updated) {
        const current = await trx
          .selectFrom('payment_attempts')
          .selectAll()
          .where('id', '=', attemptId)
          .executeTakeFirst();
        if (!current) throw new NotFoundDomainError('payment_attempt', attemptId);
        return { attempt: toResponse(current), won: false as const, customerId: null, paymentPaid: false };
      }

      const effect = await this.applyPaymentStatusEffect(trx, updated.order_id, decision);
      return {
        attempt: toResponse(updated),
        won: true as const,
        customerId: updated.customer_id ?? effect.customerId,
        paymentPaid: effect.paymentPaid,
        deliveryType: effect.deliveryType,
        orderNumber: effect.orderNumber,
      };
    });

    if (result.won) {
      // La transacción ya confirmó la decisión comercial. No se espera red
      // externa aquí: QrPaymentsService debe poder continuar resolviendo el
      // cargo bancario aunque el gateway esté lento o caído.
      void this.notifyDecisionBestEffort(
        attemptId,
        result.attempt.orderId,
        result.customerId,
        decision,
        result.paymentPaid,
        result.deliveryType,
        result.orderNumber,
      );
    }
    return { attempt: result.attempt, won: result.won };
  }

  /**
   * Cobro presencial en el POS: el cajero decide en el momento (a ojo, o
   * porque la confirmación automática del banco todavía no llegó — ver
   * `QrPaymentsService`). Si ya hay un `payment_attempt` vivo para el pedido
   * (lo normal: `QrPaymentsService.generateForOrder` ya lo dejó en
   * 'pending_review' al generar el QR real), decide sobre ESE en vez de
   * insertar uno nuevo — reusa el mismo CAS de `decide()`, cero duplicación.
   * Solo si no hay ninguno (banco caído, nunca se generó QR real) cae al
   * comportamiento original: crear y decidir en el mismo paso. El índice
   * único parcial `uq_payment_attempts_live` sigue siendo la última barrera
   * contra un segundo intento vivo en cualquiera de los dos casos.
   */
  async confirmPresencial(
    orderId: string,
    decision: 'accepted' | 'rejected',
  ): Promise<DecidePaymentAttemptResult> {
    const existingLive = await this.db
      .selectFrom('payment_attempts')
      .select('id')
      .where('order_id', '=', orderId)
      .where('review_status', '=', 'pending_review')
      .executeTakeFirst();
    if (existingLive) {
      return this.decide(existingLive.id, decision);
    }

    const result = await this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('orders')
        .select(['id', 'customer_id', 'payment_method'])
        .where('id', '=', orderId)
        .executeTakeFirst();
      if (!order) throw new NotFoundDomainError('order', orderId);
      if (order.payment_method !== 'qr' && order.payment_method !== 'split') {
        throw new ValidationError('El pedido no es de pago QR.');
      }

      let inserted;
      try {
        inserted = await trx
          .insertInto('payment_attempts')
          .values({
            order_id: orderId,
            customer_id: order.customer_id,
            opened_as: 'normal',
            review_status: decision,
            reviewed_at: new Date(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DomainException(
            'payment_attempt_already_live',
            HttpStatus.CONFLICT,
            'Ya hay un intento de pago pendiente o aceptado para este pedido.',
          );
        }
        throw error;
      }

      const effect = await this.applyPaymentStatusEffect(trx, orderId, decision);
      return {
        attempt: toResponse(inserted),
        won: true as const,
        customerId: order.customer_id ?? effect.customerId,
        paymentPaid: effect.paymentPaid,
        deliveryType: effect.deliveryType,
        orderNumber: effect.orderNumber,
      };
    });

    void this.notifyDecisionBestEffort(
      result.attempt.id,
      result.attempt.orderId,
      result.customerId,
      decision,
      result.paymentPaid,
      result.deliveryType,
      result.orderNumber,
    );
    return { attempt: result.attempt, won: result.won };
  }

  /**
   * `accepted` es plata que efectivamente entra (transferencia QR
   * confirmada) — igual que `cash/confirm`, exige caja abierta y vincula el
   * pedido a esa sesión, salvo que ya venga vinculado (pedido fuera de
   * horario, se etiquetó al aceptarse). `rejected` no mueve plata, no toca
   * la caja.
   *
   * Con `payment_method='split'` esto es solo la pata QR: `accepted` recién
   * pone `payment_status='paid'` si la pata efectivo YA está confirmada
   * (`split_cash_confirmed_at`) — si no, el pedido queda `unpaid` hasta que
   * `OrdersService.confirmCash` complete la otra pata. `rejected` en un
   * split no toca `payment_status`: rechazar la pata QR no debe deshacer
   * una pata efectivo que ya entró de verdad — el staff decide a mano qué
   * hacer con ese pedido (regenerar el QR, o resolverlo por otra vía).
   */
  private async applyPaymentStatusEffect(
    trx: Transaction<Database>,
    orderId: string,
    decision: 'accepted' | 'rejected',
  ): Promise<{
    customerId: string | null;
    paymentPaid: boolean;
    deliveryType: OrderDeliveryType;
    orderNumber: string;
  }> {
    const current = await trx
      .selectFrom('orders')
      .select(['register_session_id', 'payment_method', 'split_cash_confirmed_at', 'delivery_type', 'order_number'])
      .where('id', '=', orderId)
      .executeTakeFirstOrThrow();

    const isSplit = current.payment_method === 'split';
    if (isSplit && decision === 'rejected') {
      // No tocar payment_status: la pata efectivo, si ya entró, sigue en pie.
      const order = await trx
        .selectFrom('orders')
        .select('customer_id')
        .where('id', '=', orderId)
        .executeTakeFirstOrThrow();
      return {
        customerId: order.customer_id,
        paymentPaid: false,
        deliveryType: current.delivery_type,
        orderNumber: current.order_number,
      };
    }

    const fullyPaid = decision === 'accepted' && (!isSplit || current.split_cash_confirmed_at !== null);
    const paymentStatus: OrderPaymentStatus | undefined = decision === 'rejected'
      ? 'rejected'
      : fullyPaid
        ? 'paid'
        : undefined; // split con la pata efectivo todavía pendiente: no se toca

    let registerSessionId: string | null | undefined;
    if (decision === 'accepted') {
      registerSessionId =
        current.register_session_id ?? (await this.cashRegister.sessionIdForPayment(trx));
    }

    // CAS contra un reemplazo (FASE 3) que ganó la carrera: si el pedido ya
    // está cancelado, este UPDATE no afecta ninguna fila — Postgres
    // reevalúa el WHERE contra la versión actual de la fila recién al
    // conseguir el lock, así que esto es seguro incluso si `current` (el
    // SELECT de arriba, sin FOR UPDATE) se leyó ANTES de que el replacement
    // cancelara. Nunca se "revive" un pedido reemplazado como pagado.
    const order = await trx
      .updateTable('orders')
      .set({
        ...(paymentStatus !== undefined ? { payment_status: paymentStatus } : {}),
        ...(registerSessionId !== undefined ? { register_session_id: registerSessionId } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', orderId)
      .where('status', '!=', 'cancelled')
      .returning(['customer_id'])
      .executeTakeFirst();
    if (!order) {
      throw new DomainException(
        'order_not_payable',
        HttpStatus.CONFLICT,
        'El pedido ya fue cancelado (posiblemente reemplazado) — no se puede aplicar este pago.',
        { orderId },
      );
    }
    return {
      customerId: order.customer_id,
      paymentPaid: paymentStatus === 'paid',
      deliveryType: current.delivery_type,
      orderNumber: current.order_number,
    };
  }

  /**
   * Central decide QUÉ pasó (accepted+paid vs. rejected vs. accepted pero
   * split todavía incompleto) y manda una intención estructurada — nunca
   * texto customer-facing. `payment_confirmed` cubre tanto el cierre real
   * (`fullyPaid: true`) como la pata QR de un split que todavía espera la
   * pata efectivo (`fullyPaid: false`): el agente decide cómo diferenciarlos.
   */
  private async notifyCustomerBestEffort(
    attemptId: string,
    customerId: string | null,
    decision: 'accepted' | 'rejected',
    paymentPaid: boolean,
    deliveryType: OrderDeliveryType,
    orderNumber: string,
  ): Promise<void> {
    if (!customerId) return;
    try {
      const payload =
        decision === 'accepted'
          ? {
              customerId,
              messageType: 'payment_confirmed' as const,
              context: { orderNumber, deliveryType, fullyPaid: paymentPaid },
            }
          : {
              customerId,
              messageType: 'payment_rejected' as const,
              context: { orderNumber, deliveryType },
            };
      await this.notifications.notifyNow({
        channel: 'whatsapp',
        kind: 'payment_decision',
        targetRef: attemptId,
        payload,
      });
    } catch {
      this.logger.warn(`payment_decision_notification_failed attemptId=${attemptId}`);
    }
  }

  /** Mantiene WhatsApp antes del grupo de delivery, fuera del camino crítico de pago. */
  private async notifyDecisionBestEffort(
    attemptId: string,
    orderId: string,
    customerId: string | null,
    decision: 'accepted' | 'rejected',
    paymentPaid: boolean,
    deliveryType: OrderDeliveryType,
    orderNumber: string,
  ): Promise<void> {
    await this.notifyCustomerBestEffort(attemptId, customerId, decision, paymentPaid, deliveryType, orderNumber);
    if (decision === 'accepted' && paymentPaid) {
      await this.notifyDeliveryBestEffort(orderId);
    }
  }

  private async notifyDeliveryBestEffort(orderId: string): Promise<void> {
    try {
      await this.deliveryNotices.notifyConfirmed(orderId);
    } catch {
      this.logger.warn(`delivery_notice_notification_failed orderId=${orderId}`);
    }
  }
}

function toResponse(row: {
  id: string;
  order_id: string;
  customer_id: string | null;
  opened_at: Date | string;
  opened_as: string;
  review_status: PaymentAttemptReviewStatus;
  reviewed_at: Date | string | null;
}): PaymentAttemptResponse {
  return {
    id: row.id,
    orderId: row.order_id,
    customerId: row.customer_id,
    openedAt: new Date(row.opened_at).toISOString(),
    openedAs: row.opened_as,
    reviewStatus: row.review_status,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
  };
}
