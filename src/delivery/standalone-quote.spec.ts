import { composeStandaloneQuote } from './standalone-quote';

describe('composeStandaloneQuote', () => {
  const fee = { ok: true as const, amount: 15, bandIndex: 4 };

  it('normal, sin lluvia: total = tarifa', () => {
    expect(composeStandaloneQuote(fee, { enabled: false, amount: 3 })).toEqual({
      feeAmount: 15,
      surchargeAmount: 0,
      totalAmount: 15,
    });
  });

  it('con recargo por lluvia activo: se suma al total', () => {
    expect(composeStandaloneQuote(fee, { enabled: true, amount: 3 })).toEqual({
      feeAmount: 15,
      surchargeAmount: 3,
      totalAmount: 18,
    });
  });

  it('recargo con decimales: sin errores de punto flotante', () => {
    expect(
      composeStandaloneQuote({ ok: true, amount: 10.1, bandIndex: 1 }, { enabled: true, amount: 0.2 })
        ?.totalAmount,
    ).toBe(10.3);
  });

  it('envío gratis por política: sin tarifa y sin recargo por lluvia', () => {
    expect(
      composeStandaloneQuote({ ok: true, amount: 0, bandIndex: null, free: true }, { enabled: true, amount: 3 }),
    ).toEqual({ feeAmount: 0, surchargeAmount: 0, totalAmount: 0 });
  });

  it('fuera de rango (manual_quote) o distancia inválida: no hay montos', () => {
    expect(composeStandaloneQuote({ ok: false, reason: 'manual_quote' }, { enabled: true, amount: 3 })).toBeNull();
    expect(composeStandaloneQuote({ ok: false, reason: 'invalid_distance' }, { enabled: false, amount: 0 })).toBeNull();
  });
});
