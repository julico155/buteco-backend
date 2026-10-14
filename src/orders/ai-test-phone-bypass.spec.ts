import { StoreClosedError } from '../common/exceptions/domain-exception';
import { ALL_AVAILABLE } from '../operational-settings/availability.fixtures';
import { OrdersService } from './orders.service';

/**
 * `business_opens_hour: 0, business_closes_hour: 0` hace que
 * `classifyServiceWindow` devuelva 'closed' sin importar la hora real del
 * reloj (relCloses = 0, así que relHour >= 0 siempre es verdad) — así el
 * test no depende de a qué hora corre.
 */
const ALWAYS_CLOSED_HOURS = { business_opens_hour: 0, business_closes_hour: 0, ...ALL_AVAILABLE };

const baseDto = {
  customerName: 'Tester',
  deliveryType: 'pickup' as const,
  paymentMethod: 'cash' as const,
  items: [],
};

function createService(opts: { aiTestPhones: string[]; customerPhone?: string | null }) {
  const customersChain = {
    select: jest.fn(),
    where: jest.fn(),
    executeTakeFirst: jest.fn().mockResolvedValue(
      opts.customerPhone === undefined ? undefined : { phone: opts.customerPhone },
    ),
  };
  customersChain.select.mockReturnValue(customersChain);
  customersChain.where.mockReturnValue(customersChain);

  const db = {
    selectFrom: jest.fn((table: string) => {
      if (table === 'customers') return customersChain;
      throw new Error(`unexpected selectFrom(${table}) in this test`);
    }),
  };
  const idempotency = {
    run: jest.fn().mockResolvedValue({ created: true, body: { id: 'order-1', customerId: null }, status: 201 }),
  };
  const operationalSettings = { getRow: jest.fn().mockResolvedValue(ALWAYS_CLOSED_HOURS) };
  const cashRegister = { isOpen: jest.fn().mockResolvedValue(false) };
  const config = { get: jest.fn().mockReturnValue(opts.aiTestPhones) };

  const service = new OrdersService(
    db as never,
    idempotency as never,
    operationalSettings as never,
    {} as never,
    {} as never,
    cashRegister as never,
    {} as never,
    config as never,
    {} as never,
    { resolve: jest.fn().mockResolvedValue(null) } as never, // PaymentOptionsService,
  );
  return { service, db, idempotency, customersChain };
}

describe('OrdersService — bypass de horario para pruebas web (AI_TEST_PHONES)', () => {
  it('fuera de horario y sin allowlist configurada: sigue cerrado para web, igual que siempre (sin cambio de comportamiento)', async () => {
    const { service, db } = createService({ aiTestPhones: [] });

    await expect(
      service.create({ ...baseDto, channel: 'web', customerId: 'customer-1' }, 'idem-1', 'web-client'),
    ).rejects.toBeInstanceOf(StoreClosedError);
    // Ni siquiera consulta a customers: la allowlist vacía corta de una.
    expect(db.selectFrom).not.toHaveBeenCalledWith('customers');
  });

  it('fuera de horario, allowlist configurada pero el teléfono del cliente no está en ella: sigue cerrado', async () => {
    const { service } = createService({ aiTestPhones: ['+59170000001'], customerPhone: '+59170000099' });

    await expect(
      service.create({ ...baseDto, channel: 'web', customerId: 'customer-1' }, 'idem-1', 'web-client'),
    ).rejects.toBeInstanceOf(StoreClosedError);
  });

  it('fuera de horario, el teléfono del cliente SÍ está en AI_TEST_PHONES: salta el gate para channel=web', async () => {
    const { service, idempotency } = createService({ aiTestPhones: ['+59170000001'], customerPhone: '+59170000001' });

    const result = await service.create(
      { ...baseDto, channel: 'web', customerId: 'customer-1' },
      'idem-1',
      'web-client',
    );

    expect(result.httpStatus).toBe(201);
    expect(idempotency.run).toHaveBeenCalledTimes(1);
  });

  it('sin customerId no hay nada que resolver: sigue cerrado aunque haya allowlist', async () => {
    const { service, db } = createService({ aiTestPhones: ['+59170000001'] });

    await expect(
      service.create({ ...baseDto, channel: 'web', customerId: undefined }, 'idem-1', 'web-client'),
    ).rejects.toBeInstanceOf(StoreClosedError);
    expect(db.selectFrom).not.toHaveBeenCalledWith('customers');
  });

  it('el bypass de POS (bypassHoursGate) sigue funcionando exactamente igual, sin tocar nada de esto', async () => {
    const { service, idempotency } = createService({ aiTestPhones: [] });

    const result = await service.create(
      { ...baseDto, channel: 'pos', bypassHoursGate: true },
      'idem-1',
      'pos-client',
    );

    expect(result.httpStatus).toBe(201);
    expect(idempotency.run).toHaveBeenCalledTimes(1);
  });

  it('bypassHoursGate=true NUNCA alcanza para channel=web (solo honrado para pos)', async () => {
    const { service } = createService({ aiTestPhones: [] });

    await expect(
      service.create({ ...baseDto, channel: 'web', bypassHoursGate: true }, 'idem-1', 'web-client'),
    ).rejects.toBeInstanceOf(StoreClosedError);
  });
});
