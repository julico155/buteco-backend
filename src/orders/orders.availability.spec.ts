import { DomainException } from '../common/exceptions/domain-exception';
import { ALL_AVAILABLE } from '../operational-settings/availability.fixtures';
import { OrdersService } from './orders.service';

// El gate de horario mira el reloj real: se fija una hora dentro del margen
// (mediodía en La Paz) para que el test no dependa de cuándo se ejecuta.
beforeEach(() => {
  jest.useFakeTimers({
    now: new Date('2026-10-06T16:00:00Z'),
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate',
      'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    ],
  });
});

afterEach(() => {
  jest.useRealTimers();
});


const OPEN_HOURS = { business_opens_hour: 0, business_closes_hour: 23 };

const baseDto = {
  customerName: 'Tester',
  paymentMethod: 'cash' as const,
  items: [],
};

function createService(settings: Record<string, unknown>) {
  const idempotency = {
    run: jest
      .fn()
      .mockResolvedValue({ created: true, body: { id: 'order-1', customerId: null }, status: 201 }),
  };
  const operationalSettings = {
    getRow: jest.fn().mockResolvedValue({ ...OPEN_HOURS, ...settings }),
  };
  const cashRegister = { isOpen: jest.fn().mockResolvedValue(true) };
  const config = { get: jest.fn().mockReturnValue([]) };
  const service = new OrdersService(
    {} as never,
    idempotency as never,
    operationalSettings as never,
    {} as never,
    {} as never,
    cashRegister as never,
    {} as never,
    config as never,
    {} as never,
    { resolve: jest.fn().mockResolvedValue(null) } as never, // PaymentOptionsService
  );
  return { service, idempotency };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as DomainException).code;
  }
  throw new Error('debía lanzar');
}

describe('OrdersService.create — servicios y canales habilitados', () => {
  it('con todo habilitado crea el pedido', async () => {
    const { service, idempotency } = createService({ ...ALL_AVAILABLE });

    const result = await service.create(
      { ...baseDto, channel: 'pos', deliveryType: 'pickup' },
      'idem-1',
      'pos',
    );

    expect(result.httpStatus).toBe(201);
    expect(idempotency.run).toHaveBeenCalledTimes(1);
  });

  it('rechaza un tipo de servicio apagado antes de tocar nada más', async () => {
    const { service, idempotency } = createService({
      ...ALL_AVAILABLE,
      service_delivery_enabled: false,
    });

    const code = await codeOf(
      service.create(
        { ...baseDto, channel: 'whatsapp', deliveryType: 'delivery' },
        'idem-1',
        'whatsapp-gateway',
      ),
    );

    expect(code).toBe('service_type_disabled');
    expect(idempotency.run).not.toHaveBeenCalled();
  });

  it('el mismo local sigue aceptando los servicios que sí están prendidos', async () => {
    const { service } = createService({ ...ALL_AVAILABLE, service_delivery_enabled: false });

    const result = await service.create(
      { ...baseDto, channel: 'whatsapp', deliveryType: 'pickup' },
      'idem-1',
      'whatsapp-gateway',
    );

    expect(result.httpStatus).toBe(201);
  });

  it('rechaza un canal apagado aunque el servicio y el horario estén bien', async () => {
    const { service, idempotency } = createService({
      ...ALL_AVAILABLE,
      channel_web_enabled: false,
    });

    const code = await codeOf(
      service.create({ ...baseDto, channel: 'web', deliveryType: 'pickup' }, 'idem-1', 'web'),
    );

    expect(code).toBe('channel_disabled');
    expect(idempotency.run).not.toHaveBeenCalled();
  });

  it('apagar un canal no afecta a los demás', async () => {
    const { service } = createService({ ...ALL_AVAILABLE, channel_web_enabled: false });

    const result = await service.create(
      { ...baseDto, channel: 'pos', deliveryType: 'pickup' },
      'idem-1',
      'pos',
    );

    expect(result.httpStatus).toBe(201);
  });
});
