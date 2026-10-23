import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';

export type OrderDeliveryTypeContext = 'delivery' | 'pickup' | 'dine_in';

export interface CustomerMessageOrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  excludedComplements: string[];
  /** Solo cuando la línea tiene opciones elegidas (p. ej. «Carne 1: Pollo»); con nombres, para que el agente las muestre. */
  selectedOptions?: { groupName: string; optionName: string; priceDelta: number }[];
}

export interface CustomerMessageComboItem {
  name: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  components: { name: string; quantity: number }[];
}

/**
 * Central decide QUÉ pasó y entrega datos crudos; el agente decide CÓMO
 * comunicarlo (copy, emojis, formato) — Central nunca manda texto
 * customer-facing. Cada `messageType` fija su propio `context`.
 */
export type CustomerMessageIntent =
  | { messageType: 'order_received'; context: { orderNumber: string; deliveryType: OrderDeliveryTypeContext } }
  | {
      messageType: 'qr_confirmation';
      imageUrl: string;
      context: {
        orderNumber: string;
        currency: 'BOB';
        deliveryType: OrderDeliveryTypeContext;
        items: CustomerMessageOrderItem[];
        promotions: CustomerMessageComboItem[];
        subtotalAmount: number;
        deliveryBaseAmount: number;
        deliverySurchargeAmount: number;
        deliveryAmount: number;
        totalAmount: number;
        /** Monto autoritativo cobrado por ESTE QR: subtotalAmount, o totalAmount si qrScope='food_and_delivery'. */
        qrAmount: number;
        /** Qué cubre el QR; null fuera de un delivery pagado por QR. */
        qrScope?: 'food_only' | 'food_and_delivery' | null;
      };
    }
  | {
      /**
       * El banco no pudo generar el QR todavía: Central sigue intentando solo y,
       * si no lo logra antes de que venza el pedido sin pagar, lo cancela
       * (llega `order_expired_unpaid`). Es un aviso, no una acción del cliente.
       */
      messageType: 'qr_unavailable';
      context: { orderNumber: string; qrAmount: number; expiresInMinutes: number };
    }
  | {
      messageType: 'payment_confirmed';
      context: { orderNumber: string; deliveryType: OrderDeliveryTypeContext; fullyPaid: boolean };
    }
  | { messageType: 'payment_rejected'; context: { orderNumber: string; deliveryType: OrderDeliveryTypeContext } }
  | {
      /** Todo el pedido (comida + envío) se cobra en efectivo contra entrega — nunca incluye el caso QR (ahí el envío sigue siendo informal con el repartidor). */
      messageType: 'cash_on_delivery_confirmation';
      context: {
        orderNumber: string;
        deliveryType: OrderDeliveryTypeContext;
        subtotalAmount: number;
        deliveryBaseAmount: number;
        deliverySurchargeAmount: number;
        deliveryAmount: number;
        totalAmount: number;
      };
    }
  | { messageType: 'order_expired_unpaid'; context: { orderNumber: string } }
  | { messageType: 'late_request_unavailable'; context: { requestNumber: string } }
  | { messageType: 'late_request_accepted'; context: { requestNumber: string; orderId: string } }
  | { messageType: 'late_request_rejected'; context: { requestNumber: string } };

export type WhatsappMessagePayload = { customerId: string } & CustomerMessageIntent;

export interface WhatsappLocationRequestPayload {
  customerId: string;
  reason?: string;
  /** Pedido completo (ORD-AAMMDD-NNN); el agente decide cómo mostrarlo (#N, etc). */
  orderNumber?: string;
}

export interface TelegramAlertPayload {
  chatRef: string;
  text: string;
  /** Si se pasa, el gateway edita el mensaje ya enviado en vez de crear uno nuevo. */
  editMessageId?: string;
  buttons?: Array<{ label: string; action: string }>;
}

export interface TelegramAlertResult {
  externalMessageId: string;
}

export interface WhatsappMessageResult {
  externalMessageId: string;
}

/** Igual mensaje que antes (mismo .message), con el status HTTP adjunto para no tener que parsear texto de log. */
export class GatewayCallError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GatewayCallError';
  }
}

/**
 * Cliente HTTP hacia el "gateway API" de mensajería. El backend central
 * nunca sabe qué es WhatsApp/Kapso/Telegram — solo llama a estos tres
 * endpoints entrantes. Ver docs/gateway-integration.md.
 *
 * `notificationId` (opcional, retrocompatible): identidad ESTABLE de
 * NotificationsOutService (notification_jobs.id) que se repite igual en
 * cada reintento de la misma notificación lógica — nunca se genera una
 * nueva por retry. Viaja como header `Idempotency-Key` y como campo en el
 * body, preparando al gateway para deduplicar del otro lado sin romper el
 * contrato actual (campo nuevo y opcional; una implementación vieja que lo
 * ignore sigue funcionando exactamente igual).
 */
@Injectable()
export class GatewayClientService {
  private readonly logger = new Logger(GatewayClientService.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /**
   * Hay gateway de mensajería configurado (URL y token). Sin él, un local que
   * no usa agente de WhatsApp/Telegram opera igual: los avisos salientes se
   * omiten en vez de fallar y reintentarse.
   */
  isConfigured(): boolean {
    const { baseUrl, authToken } = this.config.get('gateway', { infer: true });
    return baseUrl.trim() !== '' && authToken.trim() !== '';
  }

  async sendWhatsappMessage(
    payload: WhatsappMessagePayload,
    notificationId?: string,
  ): Promise<WhatsappMessageResult> {
    return this.post<WhatsappMessageResult>(
      '/gateway/whatsapp/messages',
      withNotificationId(payload, notificationId),
      notificationId,
    );
  }

  async requestWhatsappLocation(
    payload: WhatsappLocationRequestPayload,
    notificationId?: string,
  ): Promise<void> {
    await this.post(
      '/gateway/whatsapp/location-requests',
      withNotificationId(payload, notificationId),
      notificationId,
    );
  }

  async sendTelegramAlert(
    payload: TelegramAlertPayload,
    notificationId?: string,
  ): Promise<TelegramAlertResult> {
    return this.post<TelegramAlertResult>(
      '/gateway/telegram/alerts',
      withNotificationId(payload, notificationId),
      notificationId,
    );
  }

  private async post<T = void>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    const { baseUrl, authToken } = this.config.get('gateway', { infer: true });
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authToken}`,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const requestId = safeCorrelationId(response.headers);
      this.logger.warn(
        `Gateway call failed: POST ${path} -> ${response.status}${requestId ? ` requestId=${requestId}` : ''}`,
      );
      throw new GatewayCallError(`Gateway call failed: POST ${path} -> ${response.status}`, response.status);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}

function withNotificationId<T extends object>(payload: T, notificationId: string | undefined): T {
  return notificationId ? { ...payload, notificationId } : payload;
}

function safeCorrelationId(headers: Headers): string | null {
  const value = headers.get('x-request-id') ?? headers.get('x-correlation-id');
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}
