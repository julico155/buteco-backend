import { StoreClosedError } from '../common/exceptions/domain-exception';
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


// Margen horario siempre abierto (0..23): solo importa la caja y la política.
const BASE_SETTINGS = { business_opens_hour: 0, business_closes_hour: 23, ...ALL_AVAILABLE };

const dto = {
  customerName: 'Tester',
  paymentMethod: 'cash' as const,
  deliveryType: 'pickup' as const,
  channel: 'pos' as const,
  items: [],
};

function createService(opts: { settings?: Record<string, unknown>; registerOpen: boolean }) {
  const idempotency = {
    run: jest
      .fn()
      .mockResolvedValue({ created: true, body: { id: 'order-1', customerId: null }, status: 201 }),
  };
  const cashRegister = { isOpen: jest.fn().mockResolvedValue(opts.registerOpen) };
  const service = new OrdersService(
    {} as never,
    idempotency as never,
    { getRow: jest.fn().mockResolvedValue({ ...BASE_SETTINGS, ...opts.settings }) } as never,
    {} as never,
    {} as never,
    cashRegister as never,
    {} as never,
    { get: jest.fn().mockReturnValue([]) } as never,
    {} as never,
    { resolve: jest.fn().mockResolvedValue(null) } as never,
  );
  const lateRequest = jest
    .spyOn(service as unknown as { createLateOrderRequest: () => Promise<unknown> }, 'createLateOrderRequest')
    .mockResolvedValue({ requestId: 'late-1' });
  return { service, idempotency, cashRegister, lateRequest };
}

describe('OrdersService.create — caja cerrada dentro del margen horario', () => {
  it('con caja abierta toma el pedido directo', async () => {
    const { service, lateRequest } = createService({ registerOpen: true });

    const result = await service.create(dto, 'idem', 'pos');

    expect(result.httpStatus).toBe(201);
    expect(lateRequest).not.toHaveBeenCalled();
  });

  it('queue (default): sin caja encola la solicitud (202)', async () => {
    const { service, lateRequest } = createService({ registerOpen: false });

    const result = await service.create(dto, 'idem', 'pos');

    expect(result.httpStatus).toBe(202);
    expect(lateRequest).toHaveBeenCalledTimes(1);
  });

  it('reject: sin caja responde cerrado y no encola', async () => {
    const { service, lateRequest, idempotency } = createService({
      registerOpen: false,
      settings: { out_of_hours_policy: 'reject' },
    });

    await expect(service.create(dto, 'idem', 'pos')).rejects.toBeInstanceOf(StoreClosedError);
    expect(lateRequest).not.toHaveBeenCalled();
    expect(idempotency.run).not.toHaveBeenCalled();
  });

  it('accept: sin caja crea el pedido directo', async () => {
    const { service, lateRequest, idempotency } = createService({
      registerOpen: false,
      settings: { out_of_hours_policy: 'accept' },
    });

    const result = await service.create(dto, 'idem', 'pos');

    expect(result.httpStatus).toBe(201);
    expect(idempotency.run).toHaveBeenCalledTimes(1);
    expect(lateRequest).not.toHaveBeenCalled();
  });

  it('caja no obligatoria: el pedido sigue directo aunque no haya caja, sin ni consultarla', async () => {
    const { service, cashRegister, lateRequest } = createService({
      registerOpen: false,
      settings: { require_open_register: false },
    });

    const result = await service.create(dto, 'idem', 'pos');

    expect(result.httpStatus).toBe(201);
    expect(cashRegister.isOpen).not.toHaveBeenCalled();
    expect(lateRequest).not.toHaveBeenCalled();
  });

  it('la política nunca abre un horario fuera del margen ancho', async () => {
    const { service, idempotency } = createService({
      registerOpen: true,
      // opens 0 / closes 0: siempre cerrado, sin importar la hora del reloj.
      settings: { business_opens_hour: 0, business_closes_hour: 0, out_of_hours_policy: 'accept' },
    });

    await expect(service.create(dto, 'idem', 'pos')).rejects.toBeInstanceOf(StoreClosedError);
    expect(idempotency.run).not.toHaveBeenCalled();
  });
});
