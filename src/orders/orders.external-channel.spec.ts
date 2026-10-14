import { DomainException } from '../common/exceptions/domain-exception';
import { ALL_AVAILABLE } from '../operational-settings/availability.fixtures';
import { OrderResponse, OrdersService } from './orders.service';

// El gate de horario mira el reloj real: se fija una hora para que el test no
// dependa de cuándo se ejecuta.
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

// Horario cerrado todo el día y caja cerrada: nada de esto debería frenar a `external`.
const CLOSED = { business_opens_hour: 0, business_closes_hour: 0 };

const baseDto = {
  customerName: 'Mesa 4',
  paymentMethod: 'cash' as const,
  items: [],
};

function createService(settings: Record<string, unknown>) {
  const createdOrder = { id: 'order-1', customerId: null, channel: 'external' } as unknown as OrderResponse;
  const idempotency = {
    // Ejecuta el callback de la transacción, como lo haría el servicio real.
    run: jest.fn(async (args: { execute: (trx: unknown) => Promise<{ body: unknown }> }) => {
      const result = await args.execute({});
      return { created: true, body: result.body, status: 201 };
    }),
  };
  const operationalSettings = { getRow: jest.fn().mockResolvedValue({ ...CLOSED, ...settings }) };
  const cashRegister = { isOpen: jest.fn().mockResolvedValue(false) };
  const config = { get: jest.fn().mockReturnValue([]) };
  const service = new OrdersService(
    {} as never,
    idempotency as never,
    operationalSettings as never,
    {} as never,
    { notifyNow: jest.fn() } as never,
    cashRegister as never,
    {} as never,
    config as never,
    {} as never,
    { resolve: jest.fn().mockResolvedValue(null) } as never, // PaymentOptionsService
  );
  const create = jest
    .spyOn(service as unknown as { createOrderInTransaction: () => Promise<OrderResponse> }, 'createOrderInTransaction')
    .mockResolvedValue(createdOrder);
  return { service, idempotency, create };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as DomainException).code;
  }
  throw new Error('debía lanzar');
}

describe('OrdersService.create — canal external', () => {
  it('está apagado por defecto: channel_disabled', async () => {
    const { service, idempotency } = createService({ ...ALL_AVAILABLE });

    const code = await codeOf(
      service.create({ ...baseDto, channel: 'external', deliveryType: 'pickup' }, 'idem-1', 'external'),
    );

    expect(code).toBe('channel_disabled');
    expect(idempotency.run).not.toHaveBeenCalled();
  });

  it('no admite delivery', async () => {
    const { service } = createService({ ...ALL_AVAILABLE, channel_external_enabled: true });

    const code = await codeOf(
      service.create({ ...baseDto, channel: 'external', deliveryType: 'delivery' }, 'idem-1', 'external'),
    );

    expect(code).toBe('validation_error');
  });

  it('entra aunque el local esté fuera de horario y sin caja, y nace cobrado', async () => {
    const { service, create } = createService({ ...ALL_AVAILABLE, channel_external_enabled: true });

    const result = await service.create(
      { ...baseDto, channel: 'external', deliveryType: 'dine_in' },
      'idem-1',
      'external',
    );

    expect(result.httpStatus).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: 'external',
        settledExternally: true,
        skipAvailabilityChecks: true,
      }),
    );
  });

  it('un pedido del POS propio no queda marcado como cobrado afuera', async () => {
    const { service, create } = createService({
      ...ALL_AVAILABLE,
      business_opens_hour: 0,
      business_closes_hour: 23,
    });

    await service.create(
      { ...baseDto, channel: 'pos', deliveryType: 'pickup', bypassHoursGate: true },
      'idem-1',
      'pos',
    );

    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channel: 'pos', settledExternally: false, skipAvailabilityChecks: false }),
    );
  });

  it('no manda avisos al cliente (ni QR) por un pedido external', async () => {
    const { service } = createService({ ...ALL_AVAILABLE, channel_external_enabled: true });
    const notifications = (service as unknown as { notifications: { notifyNow: jest.Mock } }).notifications;

    await service.notifyOrderCreated({
      id: 'order-1',
      customerId: 'customer-1',
      channel: 'external',
      paymentMethod: 'qr',
      deliveryType: 'pickup',
    } as unknown as OrderResponse);

    expect(notifications.notifyNow).not.toHaveBeenCalled();
  });
});
