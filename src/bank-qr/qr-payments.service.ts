import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../database/database.module';
import { BankQrChargeStatus, Database } from '../database/types';
import { DomainException, NotFoundDomainError, ValidationError } from '../common/exceptions/domain-exception';
import { dateInBolivia } from '../common/time/service-window';
import { AppConfig } from '../config/configuration';
import { BanecoClientService } from '../baneco/baneco-client.service';
import { PaymentAttemptsService } from '../payment-attempts/payment-attempts.service';
import { NotificationsOutService } from '../notifications-out/notifications-out.service';
import { decideUnappliedPayment } from './unapplied-payment';
import { withAmountCaption } from './qr-image-caption';
import { qrChargeAmount } from '../payment-options/payment-options.rules';

import { QrChargeResponse, UnappliedPaymentResponse } from './dto/bank-qr-response.dto';
export { QrChargeResponse, UnappliedPaymentResponse };

const QR_DUE_DATE_MARGIN_DAYS = 2;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/**
 * Genera y da seguimiento al QR real de Banco Económico para un pedido.
 * Nunca decide el pago por su cuenta — cuando confirma que el banco lo pagó
 * (ver `resolveCharge`), llama a `PaymentAttemptsService.decide()`, el mismo
 * camino que ya usa la revisión manual: reusa el CAS, el vínculo a caja y la
 * notificación al cliente sin duplicar nada de esa lógica acá.
 */
@Injectable()
export class QrPaymentsService {
  private readonly logger = new Logger(QrPaymentsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly baneco: BanecoClientService,
    private readonly paymentAttempts: PaymentAttemptsService,
    private readonly notifications: NotificationsOutService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Idempotente: si ya hay un payment_attempt vivo para el pedido (mismo
   * índice único que usa todo el resto del sistema), devuelve el QR ya
   * generado en vez de crear uno nuevo.
   */
  async generateForOrder(orderId: string): Promise<QrChargeResponse> {
    const order = await this.db
      .selectFrom('orders')
      .select([
        'id',
        'order_number',
        'bank_reference',
        'channel',
        'payment_method',
        'payment_status',
        'qr_scope',
        'delivery_type',
        'delivery_quote_status',
        'subtotal_amount',
        'total_amount',
        'split_qr_amount',
        'customer_id',
      ])
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);
    if (order.payment_method !== 'qr' && order.payment_method !== 'split') {
      throw new ValidationError('El pedido no es de pago QR.');
    }
    if (order.channel === 'pos' && this.config.get('posQrMode', { infer: true }) === 'manual') {
      throw new DomainException(
        'qr_manual_mode',
        HttpStatus.CONFLICT,
        'El QR del banco todavía no está habilitado para el POS. Confirmá el cobro a mano con POST /orders/:id/payment-attempts/confirm-presencial.',
      );
    }
    if (order.payment_status === 'paid') {
      throw new DomainException(
        'order_already_paid',
        HttpStatus.CONFLICT,
        'El pedido ya está pagado.',
      );
    }

    // Cuánto cobra el QR depende de lo que eligió el cliente (ver
    // qrChargeAmount): solo la comida (el envío lo cobra el repartidor), comida
    // + envío, o, en un split del POS, el monto que declaró el cajero.
    const chargeAmount = qrChargeAmount(order);
    if (chargeAmount === null) {
      throw new ValidationError('El pedido no tiene un monto de QR definido para el split.');
    }
    // Si el QR incluye el envío, el total solo es definitivo una vez cotizado.
    if (
      order.qr_scope === 'food_and_delivery' &&
      order.delivery_type === 'delivery' &&
      order.delivery_quote_status !== 'quoted'
    ) {
      throw new DomainException(
        'delivery_not_quoted',
        HttpStatus.CONFLICT,
        'El QR incluye el envío: el pedido tiene que estar cotizado antes de generarlo.',
        { deliveryQuoteStatus: order.delivery_quote_status },
      );
    }

    const existingAttempt = await this.db
      .selectFrom('payment_attempts')
      .select('id')
      .where('order_id', '=', orderId)
      .where('review_status', 'in', ['pending_review', 'accepted'])
      .executeTakeFirst();
    if (existingAttempt) {
      const existingCharge = await this.db
        .selectFrom('bank_qr_charges')
        .select(['order_id', 'status', sql<string>`due_date::text`.as('due_date')])
        .where('payment_attempt_id', '=', existingAttempt.id)
        .executeTakeFirst();
      if (existingCharge) return toResponse(existingCharge, orderId);
    }

    // El banco anula el QR al cerrar su `dueDate` (día calendario, no hora
    // exacta) — 2 días de margen para pagos tardíos/manuales, no afecta el
    // TTL de 20 min del pedido impago (ese corre aparte, en orders.service).
    const dueDate = dateInBolivia(new Date(Date.now() + QR_DUE_DATE_MARGIN_DAYS * 24 * 60 * 60 * 1000));
    let generated;
    try {
      generated = await this.baneco.generateQR({
        // bank_reference, no order_number: order_number reinicia cada
        // apertura de caja y puede repetirse entre turnos — el banco nunca
        // debe ver un transactionId repetido.
        transactionId: order.bank_reference,
        amount: chargeAmount,
        description: `Pedido ${order.order_number}`,
        dueDate,
      });
    } catch (error) {
      this.logger.error(`generateQR falló para ${orderId}: ${(error as Error).message}`);
      throw new DomainException(
        'qr_generation_failed',
        HttpStatus.BAD_GATEWAY,
        'No se pudo generar el QR con el banco. Reintentá en un momento.',
      );
    }

    const charge = await this.db.transaction().execute(async (trx) => {
      let attempt;
      try {
        attempt = await trx
          .insertInto('payment_attempts')
          .values({ order_id: orderId, customer_id: order.customer_id, opened_as: 'normal' })
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

      return trx
        .insertInto('bank_qr_charges')
        .values({
          order_id: orderId,
          payment_attempt_id: attempt.id,
          qr_id: generated.qrId,
          transaction_id: order.bank_reference,
          amount: chargeAmount.toFixed(2),
          due_date: dueDate,
          qr_image_base64: generated.qrImageBase64,
          raw_generate_response: JSON.stringify(generated.raw),
        })
        .returning(['order_id', 'status', sql<string>`due_date::text`.as('due_date')])
        .executeTakeFirstOrThrow();
    });

    return toResponse(charge, orderId);
  }

  async getQrImage(orderId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const charge = await this.db
      .selectFrom('bank_qr_charges')
      .innerJoin('orders', 'orders.id', 'bank_qr_charges.order_id')
      .select(['bank_qr_charges.qr_image_base64', 'bank_qr_charges.amount', 'orders.order_number'])
      .where('bank_qr_charges.order_id', '=', orderId)
      .orderBy('bank_qr_charges.created_at', 'desc')
      .executeTakeFirst();
    if (!charge) throw new NotFoundDomainError('bank_qr_charge', orderId);
    try {
      const bytes = await withAmountCaption({
        qrImageBase64: charge.qr_image_base64,
        amountBs: Number(charge.amount),
        concept: `Pedido ${charge.order_number}`,
      });
      return { bytes, mimeType: 'image/png' };
    } catch (error) {
      // El QR original del banco sigue siendo válido y escaneable sin la
      // leyenda — mejor mandar eso que fallar el cobro por un problema de
      // renderizado.
      this.logger.warn(`No se pudo componer la leyenda del QR para ${orderId}: ${(error as Error).message}`);
      return { bytes: Buffer.from(charge.qr_image_base64, 'base64'), mimeType: 'image/png' };
    }
  }

  /** Re-verifica un qrId puntual contra el banco y resuelve si corresponde. Usado por el cron y por el webhook. */
  async resolveCharge(qrId: string): Promise<void> {
    // Nunca selectAll acá: el cron corre cada 5s y la fila trae la imagen del QR + payloads crudos (~70KB).
    // due_date::text porque el driver pg devuelve `date` como objeto Date, no como 'YYYY-MM-DD'.
    const charge = await this.db
      .selectFrom('bank_qr_charges')
      .innerJoin('payment_attempts', 'payment_attempts.id', 'bank_qr_charges.payment_attempt_id')
      .select([
        'bank_qr_charges.id as id',
        'bank_qr_charges.order_id as order_id',
        'bank_qr_charges.payment_attempt_id as payment_attempt_id',
        'bank_qr_charges.amount as amount',
        'bank_qr_charges.paid_detected_at as paid_detected_at',
        sql<string>`bank_qr_charges.due_date::text`.as('due_date'),
        'payment_attempts.review_status as review_status',
      ])
      .where('bank_qr_charges.qr_id', '=', qrId)
      .where('bank_qr_charges.status', '=', 'pending')
      .executeTakeFirst();
    if (!charge) return;

    // El intento ya se cerró por otra vía (rechazado, o cobrado a mano): este QR no debe seguir vivo.
    if (charge.review_status !== 'pending_review') {
      await this.closeCharge(charge.id, qrId, 'cancelled');
      return;
    }

    let statusResult;
    try {
      statusResult = await this.baneco.statusQR(qrId);
    } catch (error) {
      this.logger.warn(`statusQR falló para ${qrId}: ${(error as Error).message}`);
      return;
    }

    if (statusResult.statusQrCode === 1) {
      // El pago SIEMPRE se aplica antes de marcar el cobro como confirmado:
      // 'confirmed' es lo que hace que el cron deje de mirar este qrId, así
      // que marcarlo primero y fallar después dejaría la plata cobrada en el
      // banco y el pedido impago, sin reintento. decide() es idempotente
      // (CAS), así que si el proceso muere entre ambos pasos el cron
      // reintenta sin aplicar el pago dos veces.
      try {
        await this.paymentAttempts.decide(charge.payment_attempt_id, 'accepted');
      } catch (error) {
        await this.handleUnappliedPayment(charge, qrId, statusResult.raw, error);
        return;
      }
      await this.db
        .updateTable('bank_qr_charges')
        .set({
          status: 'confirmed',
          raw_status_response: JSON.stringify(statusResult.raw),
          updated_at: new Date(),
        })
        .where('id', '=', charge.id)
        .execute();
      return;
    }

    if (statusResult.statusQrCode === 9) {
      await this.db
        .updateTable('bank_qr_charges')
        .set({
          status: 'cancelled',
          raw_status_response: JSON.stringify(statusResult.raw),
          updated_at: new Date(),
        })
        .where('id', '=', charge.id)
        .execute();
      return;
    }

    // statusQrCode === 0 (sigue pendiente): si ya venció, se anula del lado
    // del banco y se marca expired — el payment_attempt sigue pending_review
    // para que el staff pueda regenerar o confirmar a mano.
    if (charge.due_date < dateInBolivia(new Date())) {
      await this.closeCharge(charge.id, qrId, 'expired');
    }
  }

  /**
   * El banco cobró pero el pago no se pudo aplicar al pedido — en la
   * práctica, siempre `cash_register_closed`: entró con la caja cerrada.
   * La plata ya está en la cuenta, así que no se descarta ni se aplica a
   * destiempo (aplicarla al abrir la caja de mañana la metería en el cuadre
   * de otra jornada, y el pedido de anoche ya no se cocina).
   *
   * Dentro del margen de gracia se deja `pending` y el cron reintenta, que
   * cubre el cierre corto por cambio de turno. Pasado el margen se asume
   * jornada terminada: queda `paid_unapplied` y se avisa al staff para que
   * alguien decida (aplicarlo, o devolverle la plata al cliente a mano — el
   * banco no expone API de devolución).
   */
  private async handleUnappliedPayment(
    charge: { id: string; order_id: string; amount: string; paid_detected_at: Date | null },
    qrId: string,
    rawStatus: unknown,
    error: unknown,
  ): Promise<void> {
    // El pedido ya fue cancelado (FASE 3: reemplazado por otro, o vencido) —
    // no es un fallo transitorio como la caja cerrada, es permanente:
    // ningún reintento lo va a arreglar. Directo a paid_unapplied, sin
    // margen de gracia, para que el staff decida (aplicar a mano o
    // devolver la plata) en vez de que el cron lo reintente para siempre.
    if (error instanceof DomainException && error.code === 'order_not_payable') {
      await this.escalateUnapplied(
        charge,
        rawStatus,
        new Date(),
        'El pedido ya fue cancelado (posiblemente reemplazado por uno nuevo) antes de que el banco confirmara el pago.',
      );
      return;
    }

    const isCashRegisterClosed =
      error instanceof DomainException && error.code === 'cash_register_closed';
    if (!isCashRegisterClosed) {
      // Fallo inesperado (red, base): se deja 'pending' a propósito para que
      // el cron lo reintente en el próximo tick.
      this.logger.error(
        `No se pudo aplicar el pago de ${qrId}: ${(error as Error).message}`,
      );
      return;
    }

    const now = new Date();
    const firstDetectedAt = charge.paid_detected_at ? new Date(charge.paid_detected_at) : null;

    if (decideUnappliedPayment(firstDetectedAt, now) === 'retry_later') {
      await this.db
        .updateTable('bank_qr_charges')
        .set({
          paid_detected_at: firstDetectedAt ?? now,
          raw_status_response: JSON.stringify(rawStatus),
          updated_at: now,
        })
        .where('id', '=', charge.id)
        .execute();
      this.logger.warn(`Pago de ${qrId} sin caja abierta; se reintenta dentro del margen.`);
      return;
    }

    await this.escalateUnapplied(
      charge,
      rawStatus,
      now,
      'Entró con la caja cerrada: hay que aplicarlo si el local sigue abierto, o devolverle la plata al cliente.',
    );
  }

  /** Cobro cobrado que definitivamente no se puede aplicar — paid_unapplied + alerta a staff, CAS para no duplicar. */
  private async escalateUnapplied(
    charge: { id: string; order_id: string; amount: string; paid_detected_at: Date | null },
    rawStatus: unknown,
    now: Date,
    reasonText: string,
  ): Promise<void> {
    // El banco ya reportó este cobro como pagado — paid_detected_at marca
    // ESE momento, no el del escalamiento. Si ya tenía uno (p.ej. vino del
    // margen de gracia de caja cerrada) no se pisa; si es la primera vez que
    // lo vemos (escalamiento directo por order_not_payable) se setea ahora.
    const escalated = await this.db
      .updateTable('bank_qr_charges')
      .set({
        status: 'paid_unapplied',
        paid_detected_at: charge.paid_detected_at ?? now,
        raw_status_response: JSON.stringify(rawStatus),
        updated_at: now,
      })
      .where('id', '=', charge.id)
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst();
    // CAS: si otro tick ya escaló este cobro, no se duplica la alerta.
    if (!escalated) return;

    this.logger.error(
      `Pago cobrado sin aplicar (${charge.id}, pedido ${charge.order_id}, Bs ${charge.amount}): requiere decisión manual.`,
    );

    const order = await this.db
      .selectFrom('orders')
      .select(['order_number', 'customer_name'])
      .where('id', '=', charge.order_id)
      .executeTakeFirst();

    try {
      await this.notifications.notifyNow({
        channel: 'telegram',
        kind: 'qr_paid_unapplied_alert',
        targetRef: charge.id,
        payload: {
          chatRef: 'staff-group',
          text:
            `Pago QR cobrado SIN aplicar — pedido ${order?.order_number ?? charge.order_id}` +
            ` (${order?.customer_name ?? 'sin nombre'}), Bs ${charge.amount}. ${reasonText}`,
        },
      });
    } catch (notifyError) {
      this.logger.warn(
        `No se pudo avisar del pago sin aplicar ${charge.id}: ${(notifyError as Error).message}`,
      );
    }
  }

  /** Anula el QR del lado del banco (best-effort) y deja de consultarlo. */
  private async closeCharge(
    chargeId: string,
    qrId: string,
    status: 'cancelled' | 'expired',
  ): Promise<void> {
    try {
      await this.baneco.cancelQR(qrId);
    } catch (error) {
      this.logger.warn(`cancelQR falló para ${qrId} (${status}): ${(error as Error).message}`);
    }
    await this.db
      .updateTable('bank_qr_charges')
      .set({ status, updated_at: new Date() })
      .where('id', '=', chargeId)
      .execute();
  }

  /** Cola de pagos cobrados que ninguna caja recibió — la pantalla donde se decide qué hacer con cada uno. */
  async findUnappliedPayments(): Promise<UnappliedPaymentResponse[]> {
    const rows = await this.db
      .selectFrom('bank_qr_charges')
      .innerJoin('orders', 'orders.id', 'bank_qr_charges.order_id')
      .leftJoin('customers', 'customers.id', 'orders.customer_id')
      .select([
        'bank_qr_charges.id as id',
        'bank_qr_charges.order_id as order_id',
        'bank_qr_charges.qr_id as qr_id',
        'bank_qr_charges.amount as amount',
        'bank_qr_charges.paid_detected_at as paid_detected_at',
        'orders.order_number as order_number',
        'orders.customer_name as customer_name',
        'orders.payment_status as payment_status',
        'customers.phone as customer_phone',
      ])
      .where('bank_qr_charges.status', '=', 'paid_unapplied')
      .orderBy('bank_qr_charges.paid_detected_at', 'asc')
      .execute();

    return rows.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      orderNumber: r.order_number,
      customerName: r.customer_name,
      // Para poder escribirle al cliente y devolverle la plata.
      customerPhone: r.customer_phone,
      qrId: r.qr_id,
      amount: Number(r.amount),
      paidDetectedAt: r.paid_detected_at ? new Date(r.paid_detected_at).toISOString() : null,
      orderPaymentStatus: r.payment_status,
    }));
  }

  /**
   * Aplica a mano un pago que había quedado sin aplicar (el local sigue
   * abierto, o se reabrió la caja). Exige caja abierta como cualquier otro
   * cobro: es `decide()` el que la valida, igual que en el camino normal.
   */
  async applyUnappliedPayment(chargeId: string): Promise<void> {
    const charge = await this.loadUnapplied(chargeId);
    await this.paymentAttempts.decide(charge.payment_attempt_id, 'accepted');
    await this.db
      .updateTable('bank_qr_charges')
      .set({ status: 'confirmed', updated_at: new Date() })
      .where('id', '=', chargeId)
      .where('status', '=', 'paid_unapplied')
      .execute();
  }

  /**
   * La plata se le devolvió al cliente por fuera (el banco no expone API de
   * devolución). Esto solo deja registro de que ya se resolvió, para sacarlo
   * de la cola; el pedido no se toca — cancelarlo o no es decisión aparte.
   */
  async markRefunded(chargeId: string, notes: string | undefined): Promise<void> {
    await this.loadUnapplied(chargeId);
    await this.db
      .updateTable('bank_qr_charges')
      .set({ status: 'refunded', resolution_notes: notes ?? null, updated_at: new Date() })
      .where('id', '=', chargeId)
      .where('status', '=', 'paid_unapplied')
      .execute();
  }

  private async loadUnapplied(chargeId: string) {
    const charge = await this.db
      .selectFrom('bank_qr_charges')
      .select(['id', 'payment_attempt_id', 'status'])
      .where('id', '=', chargeId)
      .executeTakeFirst();
    if (!charge) throw new NotFoundDomainError('bank_qr_charge', chargeId);
    if (charge.status !== 'paid_unapplied') {
      throw new DomainException(
        'charge_not_unapplied',
        HttpStatus.CONFLICT,
        `El cobro no está pendiente de decisión (estado actual: ${charge.status}).`,
      );
    }
    return charge;
  }

  async recordNotifyPayload(qrId: string | null, payload: unknown): Promise<void> {
    if (!qrId) return;
    await this.db
      .updateTable('bank_qr_charges')
      .set({ raw_notify_payload: JSON.stringify(payload), updated_at: new Date() })
      .where('qr_id', '=', qrId)
      .execute();
  }

  async findPendingQrIds(limit: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom('bank_qr_charges')
      .select('qr_id')
      .where('status', '=', 'pending')
      .orderBy('created_at', 'asc')
      .limit(limit)
      .execute();
    return rows.map((r) => r.qr_id);
  }

  /** Best-effort: cancelar el QR bancario cuando el pedido se cancela por afuera. No bloquea la cancelación del pedido. */
  async cancelForOrder(orderId: string): Promise<void> {
    const charge = await this.db
      .selectFrom('bank_qr_charges')
      .select(['id', 'qr_id'])
      .where('order_id', '=', orderId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (!charge) return;

    try {
      await this.baneco.cancelQR(charge.qr_id);
    } catch (error) {
      this.logger.warn(`cancelQR falló al cancelar pedido ${orderId}: ${(error as Error).message}`);
    }
    await this.db
      .updateTable('bank_qr_charges')
      .set({ status: 'cancelled', updated_at: new Date() })
      .where('id', '=', charge.id)
      .execute();
  }
}

function toResponse(
  charge: { order_id: string; status: BankQrChargeStatus; due_date: string },
  orderId: string,
): QrChargeResponse {
  return {
    orderId,
    status: charge.status,
    qrImageUrl: `/orders/${orderId}/qr-image`,
    dueDate: charge.due_date,
  };
}
