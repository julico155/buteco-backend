import {
  assertManualQuoteAmount,
  automaticCeilingMeters,
  PricingSettings,
  resolveDeliveryFee,
} from './delivery-pricing';
import { DeliveryFee } from './delivery-tariff.service';

const BANDS: PricingSettings = { mode: 'bands', fixedFee: null, freeOverAmount: null, maxDistanceMeters: null };

function band(fee: DeliveryFee) {
  return jest.fn(async () => fee);
}

describe('resolveDeliveryFee — modo bands', () => {
  it('usa la banda que corresponde', async () => {
    const bandFee = band({ ok: true, amount: 12, bandIndex: 2 });
    const fee = await resolveDeliveryFee({ settings: BANDS, meters: 1500, subtotal: 40, bandFee });
    expect(fee).toEqual({ ok: true, amount: 12, bandIndex: 2 });
  });

  it('más allá de la última banda sigue siendo cotización manual', async () => {
    const bandFee = band({ ok: false, reason: 'manual_quote' });
    const fee = await resolveDeliveryFee({ settings: BANDS, meters: 99_000, subtotal: 40, bandFee });
    expect(fee).toEqual({ ok: false, reason: 'manual_quote' });
  });

  it('gratis sobre un monto: el subtotal alcanza → 0 y marca free', async () => {
    const settings = { ...BANDS, freeOverAmount: 50 };
    const bandFee = band({ ok: true, amount: 12, bandIndex: 2 });
    const fee = await resolveDeliveryFee({ settings, meters: 1500, subtotal: 50, bandFee });
    expect(fee).toEqual({ ok: true, amount: 0, bandIndex: 2, free: true });
  });

  it('gratis sobre un monto: el subtotal no alcanza → tarifa normal', async () => {
    const settings = { ...BANDS, freeOverAmount: 50 };
    const bandFee = band({ ok: true, amount: 12, bandIndex: 2 });
    const fee = await resolveDeliveryFee({ settings, meters: 1500, subtotal: 49.99, bandFee });
    expect(fee).toEqual({ ok: true, amount: 12, bandIndex: 2 });
  });

  it('sin subtotal (cotización suelta) no aplica la gratuidad', async () => {
    const settings = { ...BANDS, freeOverAmount: 50 };
    const bandFee = band({ ok: true, amount: 12, bandIndex: 2 });
    const fee = await resolveDeliveryFee({ settings, meters: 1500, subtotal: null, bandFee });
    expect(fee).toMatchObject({ amount: 12 });
  });

  it('el techo configurado gana sobre una banda más lejana', async () => {
    const settings = { ...BANDS, maxDistanceMeters: 3000 };
    const bandFee = band({ ok: true, amount: 20, bandIndex: 5 });
    const fee = await resolveDeliveryFee({ settings, meters: 3500, subtotal: 40, bandFee });
    expect(fee).toEqual({ ok: false, reason: 'manual_quote' });
    expect(bandFee).not.toHaveBeenCalled();
  });

  it('un envío gratis fuera del techo igual va a cotización manual', async () => {
    const settings = { ...BANDS, freeOverAmount: 10 };
    const bandFee = band({ ok: false, reason: 'manual_quote' });
    const fee = await resolveDeliveryFee({ settings, meters: 99_000, subtotal: 500, bandFee });
    expect(fee).toEqual({ ok: false, reason: 'manual_quote' });
  });

  it('distancia inválida', async () => {
    const fee = await resolveDeliveryFee({
      settings: BANDS,
      meters: Number.NaN,
      subtotal: 10,
      bandFee: band({ ok: true, amount: 1, bandIndex: 1 }),
    });
    expect(fee).toEqual({ ok: false, reason: 'invalid_distance' });
  });
});

describe('resolveDeliveryFee — fixed y free', () => {
  const FIXED: PricingSettings = { mode: 'fixed', fixedFee: 8, freeOverAmount: null, maxDistanceMeters: null };

  it('fixed: el mismo monto a cualquier distancia, sin tocar las bandas', async () => {
    const bandFee = jest.fn();
    const fee = await resolveDeliveryFee({ settings: FIXED, meters: 17_000, subtotal: 30, bandFee });
    expect(fee).toEqual({ ok: true, amount: 8, bandIndex: null });
    expect(bandFee).not.toHaveBeenCalled();
  });

  it('fixed con gratis sobre un monto', async () => {
    const settings = { ...FIXED, freeOverAmount: 60 };
    const fee = await resolveDeliveryFee({ settings, meters: 500, subtotal: 60, bandFee: jest.fn() });
    expect(fee).toEqual({ ok: true, amount: 0, bandIndex: null, free: true });
  });

  it('fixed con techo: más allá, cotización manual', async () => {
    const settings = { ...FIXED, maxDistanceMeters: 5000 };
    const fee = await resolveDeliveryFee({ settings, meters: 5001, subtotal: 30, bandFee: jest.fn() });
    expect(fee).toEqual({ ok: false, reason: 'manual_quote' });
  });

  it('free: siempre 0 y free', async () => {
    const settings: PricingSettings = { mode: 'free', fixedFee: null, freeOverAmount: null, maxDistanceMeters: null };
    const fee = await resolveDeliveryFee({ settings, meters: 8000, subtotal: 5, bandFee: jest.fn() });
    expect(fee).toEqual({ ok: true, amount: 0, bandIndex: null, free: true });
  });
});

describe('automaticCeilingMeters', () => {
  it('bands: la última banda', () => {
    expect(automaticCeilingMeters({ mode: 'bands', maxDistanceMeters: null }, 18_000)).toBe(18_000);
  });

  it('bands con techo menor: gana el menor', () => {
    expect(automaticCeilingMeters({ mode: 'bands', maxDistanceMeters: 10_000 }, 18_000)).toBe(10_000);
  });

  it('bands con techo mayor: gana la última banda', () => {
    expect(automaticCeilingMeters({ mode: 'bands', maxDistanceMeters: 30_000 }, 18_000)).toBe(18_000);
  });

  it('fixed/free sin techo: sin límite', () => {
    expect(automaticCeilingMeters({ mode: 'fixed', maxDistanceMeters: null }, null)).toBeNull();
    expect(automaticCeilingMeters({ mode: 'free', maxDistanceMeters: null }, 18_000)).toBeNull();
  });

  it('fixed con techo: ese techo', () => {
    expect(automaticCeilingMeters({ mode: 'fixed', maxDistanceMeters: 6000 }, null)).toBe(6000);
  });
});

describe('assertManualQuoteAmount', () => {
  it('acepta un monto válido hasta el tope inclusive', () => {
    expect(() => assertManualQuoteAmount(25.5, 500)).not.toThrow();
    expect(() => assertManualQuoteAmount(500, 500)).not.toThrow();
  });

  it('el tope es el configurado, no uno fijo', () => {
    expect(() => assertManualQuoteAmount(600, 1000)).not.toThrow();
    expect(() => assertManualQuoteAmount(150, 100)).toThrow(/máximo de 100/);
  });

  it('rechaza cero, negativos y no finitos', () => {
    for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertManualQuoteAmount(amount, 500)).toThrow();
    }
  });

  it('rechaza más de dos decimales', () => {
    expect(() => assertManualQuoteAmount(10.123, 500)).toThrow(/2 decimales/);
  });
});
