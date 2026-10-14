import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, sql, Transaction } from 'kysely';
import { AppConfig } from '../config/configuration';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { ValidationError } from '../common/exceptions/domain-exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { normalizePhone } from '../customers/normalize-phone';
import type { OrderQuoteResponse } from '../delivery/delivery.service';
import { OrdersService } from '../orders/orders.service';
import { AttachAgentLocationDto } from './dto/attach-agent-location.dto';

export const AGENT_LOCATION_ENDPOINT = 'POST /internal/agent/locations/attach';

export interface AgentLocationOrderSummary {
  id: string;
  orderNumber: string;
  totalAmount: number;
}

export type AgentLocationResponse =
  | { result: 'no_order' }
  | { result: 'ambiguous_order'; orders: AgentLocationOrderSummary[] }
  | { result: 'location_conflict'; orders: AgentLocationOrderSummary[] }
  | { result: 'already_attached'; orderId: string; orderNumber: string }
  | { result: 'attached'; orderId: string; orderNumber: string; quote: OrderQuoteResponse };

interface OrderRow {
  id: string;
  order_number: string;
  total_amount: string;
  status: string;
  delivery_quote_status: string | null;
  delivery_latitude: number | null;
  delivery_longitude: number | null;
}

const summarize = (o: {
  id: string;
  order_number: string;
  total_amount: string;
}): AgentLocationOrderSummary => ({
  id: o.id,
  orderNumber: o.order_number,
  totalAmount: Number(o.total_amount),
});

/**
 * El agente manda teléfono + coordenadas y Central resuelve TODO lo demás:
 * qué cliente, qué pedido está esperando ubicación, si guardar/cotizar o
 * rechazar. El agente nunca conoce el orderId ni consulta pedidos.
 */
@Injectable()
export class AgentLocationsService {
  private readonly logger = new Logger(AgentLocationsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly idempotency: IdempotencyService,
    private readonly orders: OrdersService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async attach(dto: AttachAgentLocationDto, apiClient: string): Promise<AgentLocationResponse> {
    const phone = normalizePhone(dto.customerPhone, { assumeInternational: true });
    if (phone.replace(/\D/g, '').length < 6) {
      throw new ValidationError('customerPhone no parece un teléfono válido.');
    }
    const location = { latitude: dto.latitude, longitude: dto.longitude };

    // Un mismo sourceMessageId con el mismo cuerpo devuelve la respuesta ya
    // guardada; con otro cuerpo, 409 idempotency_key_reused. Si algo falla a
    // mitad, la transacción entera (incluida la clave) se revierte y el
    // reintento vuelve a ejecutar.
    const outcome = await this.idempotency.run<AgentLocationResponse>({
      apiClient,
      endpoint: AGENT_LOCATION_ENDPOINT,
      idempotencyKey: dto.sourceMessageId,
      requestBody: {
        customerPhone: dto.customerPhone,
        latitude: dto.latitude,
        longitude: dto.longitude,
      },
      execute: async (trx) => ({ status: 200, body: await this.resolve(trx, phone, location) }),
    });

    // Recién acá el pedido tiene total final (ver
    // OrdersService.sendQrConfirmationAfterQuote): fuera de la transacción del
    // idempotency.run y solo en una ejecución real, nunca en un replay.
    if (outcome.created && outcome.body.result === 'attached' && outcome.body.quote.result === 'applied') {
      const { orderId } = outcome.body;
      this.orders
        .sendQrConfirmationAfterQuote(orderId)
        .catch((error: Error) =>
          this.logger.warn(`No se pudo notificar QR tras cotizar ${orderId}: ${error.message}`),
        );
    }
    return outcome.body;
  }

  private async resolve(
    trx: Transaction<Database>,
    phone: string,
    location: { latitude: number; longitude: number },
  ): Promise<AgentLocationResponse> {
    const customer = await trx
      .selectFrom('customers')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirst();
    if (!customer) return { result: 'no_order' };

    // "Esperando ubicación" = awaiting_location y DENTRO del TTL de pedidos sin
    // pagar. El cron de vencimiento corre cada 30 s, así que un pedido recién
    // vencido puede seguir en awaiting_location unos segundos: no se revive.
    // El TTL se compara con el reloj de la base, no con el del proceso.
    const ttlMinutes = this.config.get('unpaidOrderTtlMinutes', { infer: true });
    const waiting: OrderRow[] = await trx
      .selectFrom('orders')
      .select([
        'id',
        'order_number',
        'total_amount',
        'status',
        'delivery_quote_status',
        'delivery_latitude',
        'delivery_longitude',
      ])
      .where('customer_id', '=', customer.id)
      .where('delivery_type', '=', 'delivery')
      .where('status', '=', 'awaiting_location')
      .where(sql<boolean>`created_at > now() - (${ttlMinutes} * interval '1 minute')`)
      .orderBy('created_at', 'asc')
      .forUpdate()
      .execute();

    if (waiting.length >= 2) {
      return { result: 'ambiguous_order', orders: waiting.map(summarize) };
    }

    if (waiting.length === 1) {
      const order = waiting[0];
      const applied = await this.orders.applyLocationLocked(trx, order, location);
      if (applied.decision === 'conflict') {
        return { result: 'location_conflict', orders: [summarize(order)] };
      }
      if (applied.decision === 'already_attached') {
        return { result: 'already_attached', orderId: order.id, orderNumber: order.order_number };
      }
      return {
        result: 'attached',
        orderId: order.id,
        orderNumber: order.order_number,
        quote: applied.quote as OrderQuoteResponse,
      };
    }

    // 0 pedidos esperando ubicación (vigentes) => no_order, sin mirar otros
    // pedidos del cliente (confirmed, preparing, cotizados…): el agente usa este
    // resultado para pasar a POST /delivery/quotes cuando alguien manda un pin
    // solo para consultar cuánto cuesta el delivery.
    return { result: 'no_order' };
  }
}
