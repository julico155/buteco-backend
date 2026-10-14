import { buildLateOrderTelegramAction } from './orders.service';

describe('buildLateOrderTelegramAction', () => {
  const requestId = '00000000-0000-4000-8000-000000000001';

  it('emite acciones lógicas opacas para el alerta de pedido fuera de horario', () => {
    expect(buildLateOrderTelegramAction('accept', requestId)).toBe(`late_order.accept:${requestId}`);
    expect(buildLateOrderTelegramAction('reject', requestId)).toBe(`late_order.reject:${requestId}`);
  });

  it('no genera rutas HTTP y cabe en callback_data de Telegram', () => {
    for (const action of [
      buildLateOrderTelegramAction('accept', requestId),
      buildLateOrderTelegramAction('reject', requestId),
    ]) {
      expect(action).not.toContain('late-order-requests/');
      expect(action).not.toMatch(/^https?:\/\//i);
      expect(Buffer.byteLength(action, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});
