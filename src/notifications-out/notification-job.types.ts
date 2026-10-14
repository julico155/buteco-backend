import {
  TelegramAlertPayload,
  WhatsappLocationRequestPayload,
  WhatsappMessagePayload,
} from '../gateway-client/gateway-client.service';

/**
 * `kind` documenta la intención de negocio; `channel` + `payload` es lo que
 * de verdad necesita el gateway para entregar el mensaje. Kinds conocidos:
 * 'order_received' | 'confirmation' | 'location_request' | 'delivery_notice'
 * | 'handoff_notice' | 'late_request_alert' | ...
 */
export type NotificationJobPayload =
  | { channel: 'whatsapp'; kind: string; targetRef: string; payload: WhatsappMessagePayload }
  | {
      channel: 'whatsapp';
      kind: 'location_request';
      targetRef: string;
      payload: WhatsappLocationRequestPayload;
    }
  | { channel: 'telegram'; kind: string; targetRef: string; payload: TelegramAlertPayload };
