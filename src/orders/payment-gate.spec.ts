import { requiresPaymentBeforePreparing } from './payment-gate';

describe('requiresPaymentBeforePreparing', () => {
  it('QR y split siempre exigen pago previo', () => {
    for (const paymentMethod of ['qr', 'split'] as const) {
      for (const deliveryType of ['delivery', 'pickup', 'dine_in'] as const) {
        for (const cashPrepaymentRequired of [true, false]) {
          expect(
            requiresPaymentBeforePreparing({ paymentMethod, deliveryType, cashPrepaymentRequired }),
          ).toBe(true);
        }
      }
    }
  });

  it('efectivo sin el flag: nunca exige pago previo', () => {
    for (const deliveryType of ['delivery', 'pickup', 'dine_in'] as const) {
      expect(
        requiresPaymentBeforePreparing({
          paymentMethod: 'cash',
          deliveryType,
          cashPrepaymentRequired: false,
        }),
      ).toBe(false);
    }
  });

  it('efectivo con el flag: exige en pickup y mesa, no en delivery', () => {
    const base = { paymentMethod: 'cash' as const, cashPrepaymentRequired: true };
    expect(requiresPaymentBeforePreparing({ ...base, deliveryType: 'pickup' })).toBe(true);
    expect(requiresPaymentBeforePreparing({ ...base, deliveryType: 'dine_in' })).toBe(true);
    expect(requiresPaymentBeforePreparing({ ...base, deliveryType: 'delivery' })).toBe(false);
  });
});
