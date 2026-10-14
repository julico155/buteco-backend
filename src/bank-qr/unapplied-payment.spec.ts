import {
  decideUnappliedPayment,
  UNAPPLIED_PAYMENT_GRACE_MS,
} from './unapplied-payment';

describe('decideUnappliedPayment', () => {
  const now = new Date('2026-09-17T23:35:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('la primera detección siempre abre el margen, nunca escala de una', () => {
    expect(decideUnappliedPayment(null, now)).toBe('retry_later');
  });

  it('sigue reintentando dentro del margen (cierre corto por cambio de turno)', () => {
    expect(decideUnappliedPayment(ago(60 * 1000), now)).toBe('retry_later');
    expect(decideUnappliedPayment(ago(UNAPPLIED_PAYMENT_GRACE_MS - 1000), now)).toBe('retry_later');
  });

  it('escala cuando se pasó el margen (la jornada terminó de verdad)', () => {
    expect(decideUnappliedPayment(ago(UNAPPLIED_PAYMENT_GRACE_MS), now)).toBe('escalate');
    expect(decideUnappliedPayment(ago(2 * UNAPPLIED_PAYMENT_GRACE_MS), now)).toBe('escalate');
  });

  it('escala ante una fecha ilegible en vez de reintentar para siempre', () => {
    expect(decideUnappliedPayment(new Date(NaN), now)).toBe('escalate');
  });
});
