import { DomainException, ValidationError } from '../common/exceptions/domain-exception';
import { ALL_AVAILABLE } from '../operational-settings/availability.fixtures';
import { PaymentOptionsService } from './payment-options.service';
import { PaymentOptionRow } from './payment-options.rules';

const ALL_CHANNELS: PaymentOptionRow['channels'] = ['pos', 'whatsapp', 'web'];

const ALL_ENABLED: PaymentOptionRow[] = ([
  { service_type: 'delivery', payment_method: 'cash', qr_scope: 'none', enabled: true },
  { service_type: 'delivery', payment_method: 'qr', qr_scope: 'food_only', enabled: true },
  { service_type: 'delivery', payment_method: 'qr', qr_scope: 'food_and_delivery', enabled: false },
  { service_type: 'pickup', payment_method: 'cash', qr_scope: 'none', enabled: true },
  { service_type: 'pickup', payment_method: 'qr', qr_scope: 'none', enabled: true },
  { service_type: 'dine_in', payment_method: 'cash', qr_scope: 'none', enabled: true },
] as Omit<PaymentOptionRow, 'channels'>[]).map((row) => ({ ...row, channels: ALL_CHANNELS }));

const BANK = {
  baseUrl: 'https://bank.test',
  username: 'u',
  password: 'p',
  aesKey: 'k',
  account: 'a',
};
const NO_BANK = { baseUrl: '', username: '', password: '', aesKey: '', account: '' };

interface BuildOptions {
  /** Filas antes del PATCH (lo que ve la regla del banco). Por defecto, las mismas que `after`. */
  before?: PaymentOptionRow[];
  after: PaymentOptionRow[];
  updateFound?: boolean;
  bank?: typeof BANK;
  posQrMode?: 'bank' | 'manual';
  /** Sobrescribe la disponibilidad de servicios/canales de operational_settings. */
  availability?: Partial<typeof ALL_AVAILABLE>;
}

/** Kysely mínimo: lo que `PaymentOptionsService` realmente encadena. */
function build(options: BuildOptions) {
  const updates: Record<string, unknown>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateChain: Record<string, any> = {
    set: jest.fn((values: Record<string, unknown>) => {
      updates.push(values);
      return updateChain;
    }),
    where: jest.fn(() => updateChain),
    returning: jest.fn(() => updateChain),
    executeTakeFirst: jest.fn(async () =>
      options.updateFound === false ? undefined : { service_type: 'delivery' },
    ),
  };
  // Cada lectura de filas devuelve la siguiente: primero "antes", luego "después".
  const reads = [options.before ?? options.after, options.after];
  let readIndex = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectChain: Record<string, any> = {
    select: jest.fn(() => selectChain),
    orderBy: jest.fn(() => selectChain),
    execute: jest.fn(async () => reads[Math.min(readIndex++, reads.length - 1)]),
  };
  const executor = {
    updateTable: jest.fn(() => updateChain),
    selectFrom: jest.fn(() => selectChain),
  };
  const db = {
    ...executor,
    transaction: () => ({ execute: (cb: (trx: typeof executor) => Promise<unknown>) => cb(executor) }),
  };
  const operationalSettings = {
    getRow: jest.fn(async () => ({
      ...ALL_AVAILABLE,
      ...options.availability,
    })),
  };
  const config = {
    get: (key: string) => (key === 'baneco' ? (options.bank ?? BANK) : (options.posQrMode ?? 'bank')),
  };
  return {
    service: new PaymentOptionsService(db as never, operationalSettings as never, config as never),
    updates,
    updateChain,
  };
}

describe('PaymentOptionsService.list', () => {
  it('expone qrScope null para las filas sin alcance', async () => {
    const { service } = build({ after: ALL_ENABLED });
    const list = await service.list();

    expect(list).toContainEqual({
      serviceType: 'delivery',
      paymentMethod: 'cash',
      qrScope: null,
      enabled: true,
      channels: ALL_CHANNELS,
      available: true,
    });
    expect(list).toContainEqual({
      serviceType: 'delivery',
      paymentMethod: 'qr',
      qrScope: 'food_and_delivery',
      enabled: false,
      channels: ALL_CHANNELS,
      available: false,
    });
  });
});

describe('PaymentOptionsService.resolve', () => {
  it('delega en las reglas con las filas actuales', async () => {
    const { service } = build({ after: ALL_ENABLED });
    await expect(service.resolve({ serviceType: 'delivery', paymentMethod: 'qr' })).resolves.toBe('food_only');
    await expect(service.resolve({ serviceType: 'pickup', paymentMethod: 'cash' })).resolves.toBeNull();
  });

  it('rechaza un método apagado', async () => {
    const { service } = build({ after: ALL_ENABLED });
    await expect(
      service.resolve({ serviceType: 'delivery', paymentMethod: 'qr', qrScope: 'food_and_delivery' }),
    ).rejects.toMatchObject({ code: 'payment_method_disabled' });
  });
});

describe('PaymentOptionsService.update', () => {
  it('escribe enabled, quién lo cambió, y usa "none" para filas sin alcance', async () => {
    const { service, updates, updateChain } = build({ after: ALL_ENABLED });
    await service.update(
      [{ serviceType: 'pickup', paymentMethod: 'cash', qrScope: null, enabled: true }],
      'admin-1',
    );

    expect(updates[0]).toMatchObject({ enabled: true, updated_by: 'admin-1' });
    expect(updateChain.where).toHaveBeenCalledWith('qr_scope', '=', 'none');
  });

  it('cambia solo los canales de una forma de pago, sin tocar enabled', async () => {
    const { service, updates } = build({ after: ALL_ENABLED });
    await service.update(
      [{ serviceType: 'pickup', paymentMethod: 'qr', channels: ['pos', 'pos', 'web'] }],
      'admin-1',
    );

    expect(updates[0]).toMatchObject({ channels: ['pos', 'web'], updated_by: 'admin-1' });
    expect(updates[0]).not.toHaveProperty('enabled');
  });

  it('rechaza un cambio sin enabled ni channels', async () => {
    const { service } = build({ after: ALL_ENABLED });
    await expect(
      service.update([{ serviceType: 'pickup', paymentMethod: 'cash' }], 'admin-1'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rechaza dejar una forma de pago sin ningún canal', async () => {
    const { service } = build({ after: ALL_ENABLED });
    await expect(
      service.update([{ serviceType: 'pickup', paymentMethod: 'cash', channels: [] }], 'admin-1'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rechaza una combinación que no existe', async () => {
    const { service } = build({ after: ALL_ENABLED, updateFound: false });
    await expect(
      service.update([{ serviceType: 'delivery', paymentMethod: 'split', enabled: true }], 'admin-1'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rechaza dejar un servicio sin formas de pago, validando el estado resultante', async () => {
    const delivery = ALL_ENABLED.map((o) =>
      o.service_type === 'delivery' ? { ...o, enabled: false } : o,
    );
    const { service } = build({ before: ALL_ENABLED, after: delivery });

    const error = await service
      .update([{ serviceType: 'delivery', paymentMethod: 'cash', enabled: false }], 'admin-1')
      .catch((e: DomainException) => e);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe('no_payment_option_enabled');
  });

  it('no acepta una lista vacía', async () => {
    const { service } = build({ after: ALL_ENABLED });
    await expect(service.update([], 'admin-1')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('PaymentOptionsService.update — servicios apagados', () => {
  it('un servicio apagado no necesita forma de pago: se puede apagar su último método', async () => {
    const deliveryOff = ALL_ENABLED.map((o) =>
      o.service_type === 'delivery' ? { ...o, enabled: false } : o,
    );
    const { service } = build({
      before: ALL_ENABLED,
      after: deliveryOff,
      availability: { service_delivery_enabled: false },
    });

    await expect(
      service.update([{ serviceType: 'delivery', paymentMethod: 'cash', enabled: false }], 'admin-1'),
    ).resolves.toBeDefined();
  });
});

describe('PaymentOptionsService.update — regla del banco', () => {
  const turnOnDeliveryQrWithDelivery = [
    {
      serviceType: 'delivery' as const,
      paymentMethod: 'qr' as const,
      qrScope: 'food_and_delivery' as const,
      enabled: true,
    },
  ];

  it('bloquea activar un QR sin credenciales del banco (409 bank_not_configured)', async () => {
    const { service, updates } = build({ after: ALL_ENABLED, bank: NO_BANK });

    const error = await service.update(turnOnDeliveryQrWithDelivery, 'admin-1').catch((e) => e);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe('bank_not_configured');
    expect(updates).toHaveLength(0); // no escribió nada
  });

  it('permite activarlo con el banco configurado', async () => {
    const { service } = build({ after: ALL_ENABLED, bank: BANK });
    await expect(service.update(turnOnDeliveryQrWithDelivery, 'admin-1')).resolves.toBeDefined();
  });

  it('no bloquea reenviar una opción QR que ya estaba prendida', async () => {
    const { service } = build({ after: ALL_ENABLED, bank: NO_BANK });
    await expect(
      service.update(
        [{ serviceType: 'pickup', paymentMethod: 'qr', enabled: true }],
        'admin-1',
      ),
    ).resolves.toBeDefined();
  });

  it('no bloquea apagar ni tocar efectivo', async () => {
    const { service } = build({ after: ALL_ENABLED, bank: NO_BANK });
    await expect(
      service.update([{ serviceType: 'delivery', paymentMethod: 'qr', qrScope: 'food_only', enabled: false }], 'a'),
    ).resolves.toBeDefined();
  });

  it('modo POS manual exime al presencial, pero no al delivery', async () => {
    const pickupQrOff = ALL_ENABLED.map((o) =>
      o.service_type === 'pickup' && o.payment_method === 'qr' ? { ...o, enabled: false } : o,
    );
    const pickup = build({ before: pickupQrOff, after: ALL_ENABLED, bank: NO_BANK, posQrMode: 'manual' });
    await expect(
      pickup.service.update([{ serviceType: 'pickup', paymentMethod: 'qr', enabled: true }], 'a'),
    ).resolves.toBeDefined();

    const delivery = build({ after: ALL_ENABLED, bank: NO_BANK, posQrMode: 'manual' });
    await expect(delivery.service.update(turnOnDeliveryQrWithDelivery, 'a')).rejects.toMatchObject({
      code: 'bank_not_configured',
    });
  });
});
describe('PaymentOptionsService — disponibilidad según el banco', () => {
  const availableOf = (list: Awaited<ReturnType<PaymentOptionsService['list']>>) =>
    Object.fromEntries(list.map((o) => [`${o.serviceType}:${o.paymentMethod}:${o.qrScope ?? '-'}`, o.available]));

  it('sin banco: el efectivo está disponible y el QR no, aunque el admin lo tenga prendido', async () => {
    const { service } = build({ after: ALL_ENABLED, bank: NO_BANK });

    const available = availableOf(await service.list());

    expect(available['pickup:cash:-']).toBe(true);
    expect(available['pickup:qr:-']).toBe(false);
    expect(available['delivery:qr:food_only']).toBe(false);
  });

  it('con banco configurado el QR prendido está disponible', async () => {
    const { service } = build({ after: ALL_ENABLED, bank: BANK });

    const available = availableOf(await service.list());

    expect(available['pickup:qr:-']).toBe(true);
  });

  it('POS en modo manual sin banco: QR presencial disponible para el POS, no para WhatsApp ni delivery', async () => {
    const { service } = build({ after: ALL_ENABLED, bank: NO_BANK, posQrMode: 'manual' });

    const forPos = availableOf(await service.list('pos'));
    const forWhatsapp = availableOf(await service.list('whatsapp'));

    expect(forPos['pickup:qr:-']).toBe(true);
    expect(forPos['delivery:qr:food_only']).toBe(false);
    expect(forWhatsapp['pickup:qr:-']).toBe(false);
  });

  it('available respeta el canal de quien consulta', async () => {
    const withSplit = [
      ...ALL_ENABLED,
      { service_type: 'pickup' as const, payment_method: 'split' as const, qr_scope: 'none' as const, enabled: true, channels: ['pos', 'web'] as typeof ALL_CHANNELS },
    ];
    const { service } = build({ after: withSplit, bank: BANK });

    expect(availableOf(await service.list('pos'))['pickup:split:-']).toBe(true);
    expect(availableOf(await service.list('whatsapp'))['pickup:split:-']).toBe(false);
  });

  it('resolve rechaza un QR sin banco con payment_method_disabled y razón bank_not_configured', async () => {
    const { service } = build({ after: ALL_ENABLED, bank: NO_BANK });

    await expect(service.resolve({ serviceType: 'pickup', paymentMethod: 'qr' })).rejects.toMatchObject({
      code: 'payment_method_disabled',
      details: { reason: 'bank_not_configured' },
    });
  });

  it('resolve deja pasar el efectivo sin banco', async () => {
    const { service } = build({ after: ALL_ENABLED, bank: NO_BANK });

    await expect(service.resolve({ serviceType: 'pickup', paymentMethod: 'cash' })).resolves.toBeNull();
  });
});
