/**
 * Margen de gracia entre que el banco confirma un pago que no se puede
 * aplicar (caja cerrada) y escalarlo como `paid_unapplied`. Cubre el cierre
 * corto por cambio de turno: si alguien reabre la caja dentro del margen, el
 * cron aplica el pago solo y nadie se entera. Pasado el margen se asume que
 * la jornada terminó de verdad, y ahí sí hay que avisar a una persona.
 *
 * 20 minutos, el mismo margen que ya usa `late_order_requests` para decidir
 * que nadie va a atender un pedido fuera de horario.
 */
export const UNAPPLIED_PAYMENT_GRACE_MS = 20 * 60 * 1000;

export type UnappliedPaymentAction = 'retry_later' | 'escalate';

/**
 * `firstDetectedAt` null = es la primera vez que lo vemos pagado sin poder
 * aplicarlo, así que siempre empieza el margen en vez de escalar de una.
 */
export function decideUnappliedPayment(
  firstDetectedAt: Date | null,
  now: Date,
): UnappliedPaymentAction {
  if (firstDetectedAt === null) return 'retry_later';
  const elapsed = now.getTime() - firstDetectedAt.getTime();
  if (!Number.isFinite(elapsed)) return 'escalate';
  return elapsed < UNAPPLIED_PAYMENT_GRACE_MS ? 'retry_later' : 'escalate';
}
