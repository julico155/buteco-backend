import { requiresPaymentBeforeHandover } from './payment-gate';

describe('requiresPaymentBeforeHandover', () => {
  it('QR y split siempre exigen pago previo', () => {
    for (const paymentMethod of ['qr', 'split'] as const) {
      for (const deliveryType of ['delivery', 'pickup', 'dine_in'] as const) {
        for (const cashPrepaymentRequired of [true, false]) {
          expect(
            requiresPaymentBeforeHandover({ paymentMethod, deliveryType, cashPrepaymentRequired }),
          ).toBe(true);
        }
      }
    }
  });

  it('efectivo sin el flag: nunca exige pago previo', () => {
    for (const deliveryType of ['delivery', 'pickup', 'dine_in'] as const) {
      expect(
        requiresPaymentBeforeHandover({
          paymentMethod: 'cash',
          deliveryType,
          cashPrepaymentRequired: false,
        }),
      ).toBe(false);
    }
  });

  it('efectivo con el flag: exige en pickup y mesa, no en delivery', () => {
    const base = { paymentMethod: 'cash' as const, cashPrepaymentRequired: true };
    expect(requiresPaymentBeforeHandover({ ...base, deliveryType: 'pickup' })).toBe(true);
    expect(requiresPaymentBeforeHandover({ ...base, deliveryType: 'dine_in' })).toBe(true);
    expect(requiresPaymentBeforeHandover({ ...base, deliveryType: 'delivery' })).toBe(false);
  });
});
