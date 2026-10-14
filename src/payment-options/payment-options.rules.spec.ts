import { DomainException, ValidationError } from '../common/exceptions/domain-exception';
import {
  assertEveryServiceHasAnOption,
  bankAllows,
  PaymentOptionRow,
  qrChargeAmount,
  resolvePaymentOption,
} from './payment-options.rules';

/** Mismos defaults que la migración payment-options (1700000001000). */
function defaults(overrides: Partial<Record<string, boolean>> = {}): PaymentOptionRow[] {
  const rows: (Omit<PaymentOptionRow, 'channels'> & { key: string })[] = [
    { key: 'pickup:cash', service_type: 'pickup', payment_method: 'cash', qr_scope: 'none', enabled: true },
    { key: 'pickup:qr', service_type: 'pickup', payment_method: 'qr', qr_scope: 'none', enabled: true },
    { key: 'pickup:split', service_type: 'pickup', payment_method: 'split', qr_scope: 'none', enabled: true },
    { key: 'dine_in:cash', service_type: 'dine_in', payment_method: 'cash', qr_scope: 'none', enabled: true },
    { key: 'dine_in:qr', service_type: 'dine_in', payment_method: 'qr', qr_scope: 'none', enabled: true },
    { key: 'dine_in:split', service_type: 'dine_in', payment_method: 'split', qr_scope: 'none', enabled: true },
    { key: 'delivery:cash', service_type: 'delivery', payment_method: 'cash', qr_scope: 'none', enabled: true },
    { key: 'delivery:qr:food_only', service_type: 'delivery', payment_method: 'qr', qr_scope: 'food_only', enabled: true },
    { key: 'delivery:qr:food_and_delivery', service_type: 'delivery', payment_method: 'qr', qr_scope: 'food_and_delivery', enabled: false },
  ];
  return rows.map(({ key, ...row }) => ({
    ...row,
    enabled: overrides[key] ?? row.enabled,
    // Igual que la migración: split no se ofrece por WhatsApp.
    channels: row.payment_method === 'split' ? ['pos', 'web'] : ['pos', 'whatsapp', 'web'],
  }));
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as DomainException).code;
  }
  throw new Error('debía lanzar');
}

describe('resolvePaymentOption — presencial', () => {
  it('acepta efectivo, QR y split en pickup y mesa con los defaults', () => {
    for (const serviceType of ['pickup', 'dine_in'] as const) {
      for (const paymentMethod of ['cash', 'qr', 'split'] as const) {
        expect(resolvePaymentOption(defaults(), { serviceType, paymentMethod })).toBeNull();
      }
    }
  });

  it('rechaza con payment_method_disabled un método apagado', () => {
    const options = defaults({ 'pickup:split': false });
    expect(codeOf(() => resolvePaymentOption(options, { serviceType: 'pickup', paymentMethod: 'split' }))).toBe(
      'payment_method_disabled',
    );
    // El mismo método sigue valiendo en mesa: el toggle es por tipo de servicio.
    expect(resolvePaymentOption(options, { serviceType: 'dine_in', paymentMethod: 'split' })).toBeNull();
  });

  it('el error lista las alternativas habilitadas para ese servicio', () => {
    const options = defaults({ 'pickup:split': false });
    try {
      resolvePaymentOption(options, { serviceType: 'pickup', paymentMethod: 'split' });
      fail('debía lanzar');
    } catch (error) {
      const details = (error as DomainException).details as { available: { paymentMethod: string }[] };
      expect(details.available.map((o) => o.paymentMethod).sort()).toEqual(['cash', 'qr']);
    }
  });

  it('qrScope fuera de delivery+QR es un error de validación, no se ignora', () => {
    expect(() =>
      resolvePaymentOption(defaults(), { serviceType: 'pickup', paymentMethod: 'qr', qrScope: 'food_only' }),
    ).toThrow(ValidationError);
    expect(() =>
      resolvePaymentOption(defaults(), { serviceType: 'delivery', paymentMethod: 'cash', qrScope: 'food_only' }),
    ).toThrow(ValidationError);
  });
});

describe('resolvePaymentOption — delivery', () => {
  it('efectivo contra entrega no lleva qrScope', () => {
    expect(resolvePaymentOption(defaults(), { serviceType: 'delivery', paymentMethod: 'cash' })).toBeNull();
  });

  it('split no existe en delivery', () => {
    expect(
      codeOf(() => resolvePaymentOption(defaults(), { serviceType: 'delivery', paymentMethod: 'split' })),
    ).toBe('payment_method_disabled');
  });

  it('QR sin qrScope y solo food_only habilitado (default): usa food_only', () => {
    expect(resolvePaymentOption(defaults(), { serviceType: 'delivery', paymentMethod: 'qr' })).toBe('food_only');
  });

  it('QR sin qrScope con las dos variantes habilitadas conserva food_only (compatibilidad)', () => {
    const options = defaults({ 'delivery:qr:food_and_delivery': true });
    expect(resolvePaymentOption(options, { serviceType: 'delivery', paymentMethod: 'qr' })).toBe('food_only');
  });

  it('QR sin qrScope con solo food_and_delivery habilitado: usa esa', () => {
    const options = defaults({
      'delivery:qr:food_only': false,
      'delivery:qr:food_and_delivery': true,
    });
    expect(resolvePaymentOption(options, { serviceType: 'delivery', paymentMethod: 'qr' })).toBe(
      'food_and_delivery',
    );
  });

  it('qrScope explícito habilitado se respeta', () => {
    const options = defaults({ 'delivery:qr:food_and_delivery': true });
    expect(
      resolvePaymentOption(options, { serviceType: 'delivery', paymentMethod: 'qr', qrScope: 'food_and_delivery' }),
    ).toBe('food_and_delivery');
  });

  it('qrScope explícito apagado se rechaza aunque la otra variante esté habilitada', () => {
    expect(
      codeOf(() =>
        resolvePaymentOption(defaults(), {
          serviceType: 'delivery',
          paymentMethod: 'qr',
          qrScope: 'food_and_delivery',
        }),
      ),
    ).toBe('payment_method_disabled');
  });

  it('con las dos variantes de QR apagadas, delivery+QR se rechaza', () => {
    const options = defaults({ 'delivery:qr:food_only': false });
    expect(codeOf(() => resolvePaymentOption(options, { serviceType: 'delivery', paymentMethod: 'qr' }))).toBe(
      'payment_method_disabled',
    );
  });
});

describe('resolvePaymentOption — canal de origen', () => {
  it('con los defaults, WhatsApp acepta efectivo y QR pero no split', () => {
    expect(
      resolvePaymentOption(defaults(), { serviceType: 'pickup', paymentMethod: 'cash', channel: 'whatsapp' }),
    ).toBeNull();
    expect(
      resolvePaymentOption(defaults(), { serviceType: 'pickup', paymentMethod: 'qr', channel: 'whatsapp' }),
    ).toBeNull();
    expect(
      codeOf(() =>
        resolvePaymentOption(defaults(), { serviceType: 'pickup', paymentMethod: 'split', channel: 'whatsapp' }),
      ),
    ).toBe('payment_method_not_allowed');
  });

  it('POS y web conservan split', () => {
    for (const channel of ['pos', 'web'] as const) {
      expect(
        resolvePaymentOption(defaults(), { serviceType: 'dine_in', paymentMethod: 'split', channel }),
      ).toBeNull();
    }
  });

  it('sin channel no se valida el canal (dividir el cobro desde el POS)', () => {
    expect(resolvePaymentOption(defaults(), { serviceType: 'pickup', paymentMethod: 'split' })).toBeNull();
  });

  it('apagada gana sobre el canal: payment_method_disabled', () => {
    const options = defaults({ 'pickup:split': false });
    expect(
      codeOf(() =>
        resolvePaymentOption(options, { serviceType: 'pickup', paymentMethod: 'split', channel: 'whatsapp' }),
      ),
    ).toBe('payment_method_disabled');
  });

  it('el error lista las alternativas que ese canal sí puede usar', () => {
    try {
      resolvePaymentOption(defaults(), { serviceType: 'pickup', paymentMethod: 'split', channel: 'whatsapp' });
      fail('debía lanzar');
    } catch (error) {
      const details = (error as DomainException).details as { available: { paymentMethod: string }[] };
      expect(details.available.map((o) => o.paymentMethod).sort()).toEqual(['cash', 'qr']);
      expect((error as DomainException).getStatus()).toBe(400);
    }
  });

  it('delivery + QR sin qrScope elige la variante que el canal puede usar', () => {
    const options = defaults({ 'delivery:qr:food_and_delivery': true });
    options.find((o) => o.qr_scope === 'food_only')!.channels = ['pos'];
    expect(
      resolvePaymentOption(options, { serviceType: 'delivery', paymentMethod: 'qr', channel: 'whatsapp' }),
    ).toBe('food_and_delivery');
    // Con un qrScope explícito vedado para el canal, falla en vez de cambiarlo en silencio.
    expect(
      codeOf(() =>
        resolvePaymentOption(options, {
          serviceType: 'delivery',
          paymentMethod: 'qr',
          qrScope: 'food_only',
          channel: 'whatsapp',
        }),
      ),
    ).toBe('payment_method_not_allowed');
  });
});

describe('assertEveryServiceHasAnOption', () => {
  it('pasa con los defaults', () => {
    expect(() => assertEveryServiceHasAnOption(defaults())).not.toThrow();
  });

  it('rechaza dejar un tipo de servicio sin ninguna forma de pago', () => {
    const options = defaults({
      'delivery:cash': false,
      'delivery:qr:food_only': false,
      'delivery:qr:food_and_delivery': false,
    });
    try {
      assertEveryServiceHasAnOption(options);
      fail('debía lanzar');
    } catch (error) {
      expect((error as DomainException).code).toBe('no_payment_option_enabled');
      expect((error as DomainException).details).toEqual({ serviceTypes: ['delivery'] });
    }
  });

  it('apagar todo menos una opción en un servicio es válido', () => {
    const options = defaults({ 'pickup:cash': false, 'pickup:split': false });
    expect(() => assertEveryServiceHasAnOption(options)).not.toThrow();
  });
});

describe('qrChargeAmount', () => {
  const base = {
    payment_method: 'qr' as const,
    qr_scope: null,
    subtotal_amount: '22.00',
    total_amount: '32.00',
    split_qr_amount: null,
  };

  it('solo comida: cobra el subtotal', () => {
    expect(qrChargeAmount({ ...base, qr_scope: 'food_only' })).toBe(22);
  });

  it('comida + envío: cobra el total', () => {
    expect(qrChargeAmount({ ...base, qr_scope: 'food_and_delivery' })).toBe(32);
  });

  it('presencial (sin qrScope): subtotal, que ahí coincide con el total', () => {
    expect(qrChargeAmount({ ...base, total_amount: '22.00' })).toBe(22);
  });

  it('split: cobra el monto de la pata QR declarado', () => {
    expect(
      qrChargeAmount({ ...base, payment_method: 'split', split_qr_amount: '12.50', total_amount: '22.00' }),
    ).toBe(12.5);
  });

  it('split sin monto de QR devuelve null', () => {
    expect(qrChargeAmount({ ...base, payment_method: 'split' })).toBeNull();
  });
});
describe('bankAllows / resolvePaymentOption con el estado del banco', () => {
  const NO_BANK = { bankConfigured: false, posQrMode: 'bank' as const };
  const MANUAL = { bankConfigured: false, posQrMode: 'manual' as const };
  const WITH_BANK = { bankConfigured: true, posQrMode: 'bank' as const };

  it('efectivo siempre; QR y split solo con banco', () => {
    expect(bankAllows({ paymentMethod: 'cash', serviceType: 'pickup', bank: NO_BANK })).toBe(true);
    expect(bankAllows({ paymentMethod: 'qr', serviceType: 'pickup', bank: NO_BANK })).toBe(false);
    expect(bankAllows({ paymentMethod: 'split', serviceType: 'pickup', bank: NO_BANK })).toBe(false);
    expect(bankAllows({ paymentMethod: 'qr', serviceType: 'delivery', bank: WITH_BANK })).toBe(true);
  });

  it('sin contexto de banco no valida (compatibilidad)', () => {
    expect(bankAllows({ paymentMethod: 'qr', serviceType: 'pickup' })).toBe(true);
  });

  it('POS manual exime solo al presencial del canal POS (o sin canal: acción del cajero)', () => {
    expect(bankAllows({ paymentMethod: 'qr', serviceType: 'pickup', channel: 'pos', bank: MANUAL })).toBe(true);
    expect(bankAllows({ paymentMethod: 'qr', serviceType: 'pickup', bank: MANUAL })).toBe(true);
    expect(bankAllows({ paymentMethod: 'qr', serviceType: 'delivery', channel: 'pos', bank: MANUAL })).toBe(false);
    expect(bankAllows({ paymentMethod: 'qr', serviceType: 'pickup', channel: 'whatsapp', bank: MANUAL })).toBe(false);
  });

  it('resolve: QR prendido sin banco da payment_method_disabled con razón y sin ofrecerse a sí mismo', () => {
    try {
      resolvePaymentOption(defaults(), { serviceType: 'pickup', paymentMethod: 'qr' }, NO_BANK);
      fail('debía lanzar');
    } catch (error) {
      const e = error as DomainException;
      expect(e.code).toBe('payment_method_disabled');
      const details = e.details as { reason: string; available: { paymentMethod: string }[] };
      expect(details.reason).toBe('bank_not_configured');
      expect(details.available.map((o) => o.paymentMethod)).toEqual(['cash']);
    }
  });

  it('resolve: el efectivo pasa sin banco', () => {
    expect(resolvePaymentOption(defaults(), { serviceType: 'pickup', paymentMethod: 'cash' }, NO_BANK)).toBeNull();
  });

  it('resolve: delivery + QR sin banco se rechaza con o sin qrScope', () => {
    for (const qrScope of [undefined, 'food_only' as const]) {
      expect(
        codeOf(() => resolvePaymentOption(defaults(), { serviceType: 'delivery', paymentMethod: 'qr', qrScope }, NO_BANK)),
      ).toBe('payment_method_disabled');
    }
  });

  it('resolve: con banco todo sigue igual', () => {
    expect(resolvePaymentOption(defaults(), { serviceType: 'delivery', paymentMethod: 'qr' }, WITH_BANK)).toBe('food_only');
  });
});
