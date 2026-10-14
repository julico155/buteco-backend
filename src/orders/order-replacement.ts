import { BankQrChargeStatus, OrderPaymentStatus, OrderStatus, PaymentAttemptReviewStatus } from '../database/types';

/**
 * Estados donde un pedido todavía cuenta como "activo" para la conversación
 * con el cliente — lo que NO es esto (cancelled/delivered) no es "el último
 * pedido" de nadie, es historial.
 */
export function isActiveOrderStatus(status: OrderStatus): boolean {
  return status !== 'cancelled' && status !== 'delivered';
}

/** Único par de estados anteriores a `preparing` — antes de que el pago sea obligatorio para seguir. */
function isReplaceableStatus(status: OrderStatus): boolean {
  return status === 'awaiting_location' || status === 'confirmed';
}

export interface MoneySignalInput {
  /** `bank_qr_charges.status` de todos los cobros del pedido (vivos o no). */
  chargeStatuses: BankQrChargeStatus[];
  /** `payment_attempts.review_status` de todos los intentos del pedido. */
  attemptStatuses: PaymentAttemptReviewStatus[];
  /** true si algún cobro tiene `paid_detected_at` seteado (banco cobró, aplicado o no). */
  anyPaidDetectedAt: boolean;
}

/**
 * "¿Hay señal real de que entró plata?" — independiente de `payment_status`,
 * que puede seguir en `unpaid` mientras el banco ya cobró y no se pudo
 * aplicar (`paid_unapplied`). `pending_review`/`bank_qr_charges.status
 * === 'pending'` NO son señal: es exactamente el estado de "QR generado,
 * nadie pagó todavía" (ver QrPaymentsService.generateForOrder).
 */
export function hasMoneySignal(input: MoneySignalInput): boolean {
  if (input.anyPaidDetectedAt) return true;
  if (input.chargeStatuses.some((s) => s === 'confirmed' || s === 'paid_unapplied')) return true;
  if (input.attemptStatuses.some((s) => s === 'accepted')) return true;
  return false;
}

export type ReplaceableReasonCode =
  | 'already_paid'
  | 'payment_in_progress'
  | 'payment_status_not_unpaid'
  | 'operational';

export type ReplaceableCheckResult = { ok: true } | { ok: false; reasonCode: ReplaceableReasonCode };

/**
 * Predicado completo de "este pedido se puede reemplazar ahora mismo".
 * Fail-closed: cualquier señal de plata bloquea, sin importar qué diga
 * `status`. Se evalúa siempre de nuevo dentro de la transacción que hace el
 * replacement — nunca se cachea ni se confía en una lectura anterior.
 *
 * `payment_status` tiene que ser EXACTAMENTE 'unpaid' — no alcanza con
 * "!== 'paid'". Un pago rechazado (`rejected`) o en revisión manual
 * (`pending_review`, un campo de `orders`, distinto del `review_status` de
 * `payment_attempts`) tampoco son terreno neutral para reemplazar.
 */
export function checkReplaceable(
  order: { status: OrderStatus; paymentStatus: OrderPaymentStatus },
  money: MoneySignalInput,
): ReplaceableCheckResult {
  if (order.paymentStatus === 'paid') return { ok: false, reasonCode: 'already_paid' };
  if (order.paymentStatus !== 'unpaid') return { ok: false, reasonCode: 'payment_status_not_unpaid' };
  if (hasMoneySignal(money)) return { ok: false, reasonCode: 'payment_in_progress' };
  if (isReplaceableStatus(order.status)) return { ok: true };
  return { ok: false, reasonCode: 'operational' };
}
