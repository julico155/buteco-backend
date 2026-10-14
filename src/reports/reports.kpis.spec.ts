import { computeKpis, KpiGroupRow } from './reports.kpis';

const row = (over: Partial<KpiGroupRow>): KpiGroupRow => ({
  channel: 'pos',
  payment_method: 'cash',
  delivery_type: 'pickup',
  payment_status: 'paid',
  status: 'delivered',
  orders: 1,
  total: 10,
  ...over,
});

describe('computeKpis', () => {
  it('solo cuenta como vendido lo pagado y no cancelado', () => {
    const k = computeKpis([
      row({ orders: 4, total: 100 }),
      row({ channel: 'whatsapp', payment_method: 'qr', orders: 2, total: 50 }),
      row({ status: 'cancelled', payment_status: 'paid', orders: 1, total: 30 }),
      row({ payment_status: 'unpaid', status: 'confirmed', orders: 3, total: 45 }),
    ]);
    expect(k.totalOrders).toBe(10);
    expect(k.sold).toEqual({ orders: 6, salesAmount: 150, averageTicket: 25 });
    expect(k.cancelled).toEqual({ orders: 1, rate: 0.1 });
    expect(k.unpaid).toEqual({ orders: 3, amount: 45 });
  });

  it('desglosa por canal y método ordenado por monto', () => {
    const k = computeKpis([
      row({ orders: 4, total: 100 }),
      row({ channel: 'whatsapp', payment_method: 'qr', orders: 2, total: 150 }),
    ]);
    expect(k.byChannel.map((e) => e.key)).toEqual(['whatsapp', 'pos']);
    expect(k.byPaymentMethod[0]).toEqual({ key: 'qr', orders: 2, salesAmount: 150 });
  });

  it('sin datos devuelve ceros sin dividir por cero', () => {
    const k = computeKpis([]);
    expect(k.sold).toEqual({ orders: 0, salesAmount: 0, averageTicket: 0 });
    expect(k.cancelled.rate).toBe(0);
  });
});
