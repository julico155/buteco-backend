import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database, LateOrderRequestStatus } from '../database/types';
import { DomainException, NotFoundDomainError, ValidationError } from '../common/exceptions/domain-exception';
import { normalizePhone } from '../customers/normalize-phone';
import { LateOrderRequestAcceptedResponse, toLateRequestState } from './late-request-state';
import { NotificationsOutService } from '../notifications-out/notifications-out.service';
import { OrdersService } from '../orders/orders.service';
import { CashRegisterService } from '../cash-register/cash-register.service';

export interface LateOrderRequestResponse {
  id: string;
  requestNumber: string;
  customerId: string | null;
  customerName: string;
  status: string;
  subtotalAmount: number;
  requestedAt: string;
  expiresAt: string;
  orderId: string | null;
}

type AcceptOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'repeated'; response: LateOrderRequestResponse }
  | { outcome: 'already_settled'; status: string }
  | { outcome: 'expired' }
  | { outcome: 'order_unavailable'; reasonCode: string; customerId: string | null; requestNumber: string }
  | {
      outcome: 'accepted';
      response: LateOrderRequestResponse;
      customerId: string | null;
      orderId: string;
      /** La solicitud traía la ubicación del checkout web y el pedido nació ya ubicado y cotizado (o pendiente de cotización manual). */
      hadLocation: boolean;
    };

/**
 * Portado de `decide_late_order_request` / `accept_late_order_request`
 * (el sistema anterior, `0029_promotions.sql`). `accept` bloquea, revalida el
 * carrito ENTERO por el mismo camino que un checkout normal
 * (OrdersService.createOrderInTransaction) y solo entonces marca
 * 'accepted' con su order_id — todo en una transacción, para que nunca
 * quede "aceptada sin pedido".
 */
@Injectable()
export class LateOrderRequestsService {
  private readonly logger = new Logger(LateOrderRequestsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly ordersService: OrdersService,
    private readonly notifications: NotificationsOutService,
    private readonly cashRegister: CashRegisterService,
  ) {}

  async findById(id: string): Promise<LateOrderRequestResponse> {
    const row = await this.db
      .selectFrom('late_order_requests')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('late_order_request', id);
    return toResponse(row);
  }

  /**
   * M7A: recupera el estado definitivo de una solicitud (el 202 de `POST /orders`) a quien perdió la respuesta o recargó el
   * menú. Se busca por la `Idempotency-Key` con la que se creó, DENTRO de los pedidos del servicio que llama, y solo se
   * entrega si el teléfono pertenece al cliente de la solicitud. Cualquier otro caso (no existe, es de otro servicio, es de
   * otro cliente o no tiene cliente vinculado) da el mismo 404: no se revela si la clave existe.
   */
  async findByKey(
    apiClient: string,
    idempotencyKey: string,
    phone: string | undefined,
  ): Promise<LateOrderRequestAcceptedResponse> {
    if (!phone?.trim()) throw new ValidationError('phone es obligatorio.');
    const notFound = () => new NotFoundDomainError('late_order_request', idempotencyKey);

    const row = await this.db
      .selectFrom('late_order_requests')
      .selectAll()
      .where('api_client', '=', apiClient)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (!row || !row.customer_id) throw notFound();

    const customer = await this.db
      .selectFrom('customers')
      .select('phone')
      .where('id', '=', row.customer_id)
      .executeTakeFirst();
    if (
      !customer?.phone ||
      normalizePhone(customer.phone, { assumeInternational: true }) !==
        normalizePhone(phone, { assumeInternational: true })
    ) {
      throw notFound();
    }

    let orderNumber: string | null = null;
    if (row.status === 'accepted' && row.order_id) {
      const order = await this.db
        .selectFrom('orders')
        .select('order_number')
        .where('id', '=', row.order_id)
        .executeTakeFirst();
      orderNumber = order?.order_number ?? null;
    }
    return toLateRequestState(row, orderNumber);
  }

  /** Cola de solicitudes para el dashboard — por defecto solo las 'pending'. */
  async findMany(filter: {
    status?: LateOrderRequestStatus;
    limit?: number;
    offset?: number;
  }): Promise<LateOrderRequestResponse[]> {
    const rows = await this.db
      .selectFrom('late_order_requests')
      .selectAll()
      .where('status', '=', filter.status ?? 'pending')
      .orderBy('requested_at', 'asc')
      .limit(Math.min(filter.limit ?? 50, 200))
      .offset(filter.offset ?? 0)
      .execute();
    return rows.map(toResponse);
  }

  async accept(id: string, decidedBy: string): Promise<LateOrderRequestResponse> {
    const decidedAt = new Date();

    const result = await this.db.transaction().execute(async (trx): Promise<AcceptOutcome> => {
      const req = await trx
        .selectFrom('late_order_requests')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!req) return { outcome: 'not_found' };

      if (req.status !== 'pending') {
        if (req.status === 'accepted') return { outcome: 'repeated', response: toResponse(req) };
        return { outcome: 'already_settled', status: req.status };
      }

      if (new Date(req.expires_at) <= decidedAt) {
        await trx
          .updateTable('late_order_requests')
          .set({
            status: 'expired',
            decided_at: decidedAt,
            decided_by: 'system',
            updated_at: decidedAt,
          })
          .where('id', '=', id)
          .execute();
        return { outcome: 'expired' };
      }

      // Un pedido fuera de horario se vincula a la caja al ACEPTARSE (sea
      // cash o QR) — ahí es donde entra oficialmente al turno. Si no hay
      // caja abierta, esto tira 409 cash_register_closed sin escribir nada
      // (no hay writes todavía en este punto): la solicitud queda 'pending'
      // tal cual, para reintentar apenas alguien abra la caja — a
      // diferencia de un carrito caído, esto no es una falla permanente.
      const registerSessionId = await this.cashRegister.sessionIdForPayment(trx);

      // Los fallos permanentes (producto/promo caídos, etc.) NO se
      // reintentan: se atrapan y la solicitud queda 'rejected' con motivo
      // propio — nunca un bucle. SAVEPOINT explícito (no confiar en que
      // createOrderInTransaction valide todo ANTES de escribir): si algo
      // ahí dentro escribe y LUEGO falla, esto deshace exactamente eso, sin
      // tirar abajo la transacción completa (que también bloquea la fila
      // de late_order_requests).
      await sql`savepoint sp_checkout`.execute(trx);
      try {
        const order = await this.ordersService.createOrderInTransaction(trx, {
          customerId: req.customer_id,
          channel: req.channel,
          customerName: req.customer_name,
          deliveryType: req.delivery_type,
          paymentMethod: req.payment_method,
          qrScope: req.qr_scope,
          // La solicitud ya se validó al crearse; ver CheckoutCartInput.
          skipAvailabilityChecks: true,
          // Ubicación del checkout web guardada al crear la solicitud (migración 1700000013000). Se aplica y cotiza AQUÍ, en
          // la misma transacción que crea el pedido; sin ella (solicitudes de siempre) el pedido nace awaiting_location.
          deliveryLocation: storedLocation(req),
          notes: req.notes,
          items: req.items_json as unknown as { productId: string; quantity: number }[],
          promotions: req.promotions_json as unknown as {
            promotionId: string;
            quantity: number;
            revision: number;
          }[],
          registerSessionId,
        });

        const updated = await trx
          .updateTable('late_order_requests')
          .set({
            status: 'accepted',
            decided_at: decidedAt,
            decided_by: decidedBy,
            order_id: order.id,
            updated_at: decidedAt,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        await sql`release savepoint sp_checkout`.execute(trx);
        return {
          outcome: 'accepted',
          response: toResponse(updated),
          customerId: req.customer_id,
          orderId: order.id,
          hadLocation: storedLocation(req) !== null,
        };
      } catch (error) {
        // Solo los fallos PERMANENTES del carrito rechazan la solicitud. Un 5xx (p. ej. falta el origen del local al cotizar
        // la ubicación) es una falla de configuración, no del cliente: se propaga, se revierte todo y la solicitud sigue
        // 'pending' para reintentar cuando se corrija.
        if (error instanceof DomainException && error.getStatus() < 500) {
          await sql`rollback to savepoint sp_checkout`.execute(trx);
          await trx
            .updateTable('late_order_requests')
            .set({
              status: 'rejected',
              decided_at: decidedAt,
              decided_by: decidedBy,
              updated_at: decidedAt,
            })
            .where('id', '=', id)
            .execute();
          return {
            outcome: 'order_unavailable',
            reasonCode: error.code,
            customerId: req.customer_id,
            requestNumber: req.request_number,
          };
        }
        throw error; // error inesperado: revierte TODO, incluida la expiración de arriba si aplicara
      }
    });

    switch (result.outcome) {
      case 'not_found':
        throw new NotFoundDomainError('late_order_request', id);
      case 'repeated':
        return result.response;
      case 'already_settled':
        throw new DomainException(
          'already_settled',
          HttpStatus.CONFLICT,
          `La solicitud ya fue decidida (status=${result.status}).`,
        );
      case 'expired':
        throw new DomainException(
          'late_order_request_expired',
          HttpStatus.CONFLICT,
          'La solicitud venció antes de poder aceptarse.',
        );
      case 'order_unavailable':
        this.notifyCustomerBestEffort(id, result.customerId, {
          messageType: 'late_request_unavailable',
          context: { requestNumber: result.requestNumber },
        });
        throw new DomainException(
          'order_unavailable',
          HttpStatus.CONFLICT,
          'El pedido ya no se puede crear con el carrito original (producto o promoción caídos).',
          { reasonCode: result.reasonCode },
        );
      case 'accepted':
        this.notifyCustomerBestEffort(id, result.customerId, {
          messageType: 'late_request_accepted',
          context: { requestNumber: result.response.requestNumber, orderId: result.orderId },
        });
        if (result.hadLocation) {
          this.ordersService
            .notifyLateAcceptedWithLocation(result.orderId)
            .catch((error: Error) =>
              this.logger.warn(`No se pudo notificar el cobro tras aceptar ${id}: ${error.message}`),
            );
        }
        return result.response;
    }
  }

  async reject(id: string, decidedBy: string, _reason?: string): Promise<LateOrderRequestResponse> {
    const decidedAt = new Date();
    const updated = await this.db
      .updateTable('late_order_requests')
      .set({
        status: 'rejected',
        decided_at: decidedAt,
        decided_by: decidedBy,
        updated_at: decidedAt,
      })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .returningAll()
      .executeTakeFirst();

    if (updated) {
      this.notifyCustomerBestEffort(id, updated.customer_id, {
        messageType: 'late_request_rejected',
        context: { requestNumber: updated.request_number },
      });
      return toResponse(updated);
    }

    const existing = await this.db
      .selectFrom('late_order_requests')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) throw new NotFoundDomainError('late_order_request', id);
    if (existing.status === 'rejected') return toResponse(existing);
    throw new DomainException(
      'already_settled',
      HttpStatus.CONFLICT,
      `La solicitud ya fue decidida (status=${existing.status}).`,
    );
  }

  private notifyCustomerBestEffort(
    requestId: string,
    customerId: string | null,
    intent:
      | { messageType: 'late_request_unavailable'; context: { requestNumber: string } }
      | { messageType: 'late_request_accepted'; context: { requestNumber: string; orderId: string } }
      | { messageType: 'late_request_rejected'; context: { requestNumber: string } },
  ): void {
    if (!customerId) return;
    this.notifications
      .notifyNow({
        channel: 'whatsapp',
        kind: 'late_request_decision',
        targetRef: requestId,
        payload: { customerId, ...intent },
      })
      .catch((error: Error) =>
        this.logger.warn(`No se pudo notificar desenlace de ${requestId}: ${error.message}`),
      );
  }
}

/** Ubicación guardada en la solicitud; `null` si no trae (o la migración aún no existe y la fila no tiene las columnas). */
function storedLocation(row: {
  delivery_latitude?: number | null;
  delivery_longitude?: number | null;
}): { latitude: number; longitude: number } | null {
  return row.delivery_latitude != null && row.delivery_longitude != null
    ? { latitude: row.delivery_latitude, longitude: row.delivery_longitude }
    : null;
}

function toResponse(row: {
  id: string;
  request_number: string;
  customer_id: string | null;
  customer_name: string;
  status: string;
  subtotal_amount: string;
  requested_at: Date | string;
  expires_at: Date | string;
  order_id: string | null;
}): LateOrderRequestResponse {
  return {
    id: row.id,
    requestNumber: row.request_number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    status: row.status,
    subtotalAmount: Number(row.subtotal_amount),
    requestedAt: new Date(row.requested_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    orderId: row.order_id,
  };
}
