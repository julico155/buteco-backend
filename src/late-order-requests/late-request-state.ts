/**
 * Estado de una solicitud fuera de horario tal como lo ve el servicio que la creó (agente / menú web): lo que devuelven el
 * 202 de `POST /orders`, su reintento con la misma `Idempotency-Key` y `GET /late-order-requests/by-key/:key`.
 *
 * Es deliberadamente mínimo: nada del cliente (nombre, teléfono) ni del carrito. Una solicitud `accepted` trae el pedido en
 * que se convirtió (`orderId` / `orderNumber`) para seguirlo con `GET /orders/:id`.
 */
export type LateRequestState = 'pending' | 'accepted' | 'rejected' | 'expired';

export interface LateOrderRequestAcceptedResponse {
  requestId: string;
  requestNumber: string;
  status: LateRequestState;
  subtotalAmount: number;
  expiresAt: string;
  /** Solo cuando `status` es `accepted`: el pedido en que se convirtió. Ausentes en cualquier otro estado (el 202 pendiente es el de siempre). */
  orderId?: string;
  orderNumber?: string;
}

export function toLateRequestState(
  row: {
    id: string;
    request_number: string;
    status: string;
    subtotal_amount: string;
    expires_at: Date | string;
    order_id: string | null;
  },
  orderNumber: string | null,
  now: Date = new Date(),
): LateOrderRequestAcceptedResponse {
  const expiresAt = new Date(row.expires_at);
  // Una pendiente que ya venció todavía puede no haber pasado por el barrido de expiración: para quien consulta ya es
  // definitiva (aceptarla da `expired`, ver `LateOrderRequestsService.accept`).
  const status: LateRequestState =
    row.status === 'pending' && expiresAt.getTime() <= now.getTime() ? 'expired' : (row.status as LateRequestState);
  return {
    requestId: row.id,
    requestNumber: row.request_number,
    status,
    subtotalAmount: Number(row.subtotal_amount),
    expiresAt: expiresAt.toISOString(),
    ...(status === 'accepted' && row.order_id ? { orderId: row.order_id } : {}),
    ...(status === 'accepted' && orderNumber ? { orderNumber } : {}),
  };
}

/** HTTP del 202 y de sus reintentos: 202 mientras espera la decisión del local, 200 cuando ya es definitiva. */
export function httpStatusForLateRequest(state: LateRequestState): 200 | 202 {
  return state === 'pending' ? 202 : 200;
}
