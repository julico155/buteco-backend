import { DomainException } from '../common/exceptions/domain-exception';
import { LateOrderRequestsService } from './late-order-requests.service';

// `sql\`savepoint …\`` ejecuta SQL real contra la transacción: aquí no hay base, así que se sustituye solo esa etiqueta.
jest.mock('kysely', () => ({
  ...jest.requireActual('kysely'),
  sql: () => ({ execute: jest.fn().mockResolvedValue({ rows: [] }) }),
}));

/**
 * NO se ha ejecutado todavía. Solicitud tardía (HTTP 202) del checkout web que traía su ubicación: al aceptarla, el pedido
 * nace ya ubicado y cotizado en la misma transacción, y el cliente no recibe ningún `location_request`.
 */
const point = { latitude: -17.7833, longitude: -63.1821 };

const baseRequest = {
  id: 'req-1',
  request_number: 'SOL-000001',
  customer_id: 'customer-1',
  customer_name: 'Ana',
  channel: 'web',
  delivery_type: 'delivery',
  payment_method: 'cash',
  qr_scope: null,
  notes: null,
  items_json: [{ productId: 'p1', quantity: 2 }],
  promotions_json: [],
  subtotal_amount: '50.00',
  status: 'pending',
  requested_at: new Date('2026-10-06T10:00:00Z'),
  expires_at: new Date('2099-01-01T00:00:00Z'),
  order_id: null,
};

function createService(request: Record<string, unknown>, createOrder: jest.Mock) {
  const sets: Array<Record<string, unknown>> = [];
  const mk = (result: unknown) => {
    const api: Record<string, unknown> = {};
    for (const method of ['selectAll', 'select', 'where', 'forUpdate', 'returningAll']) api[method] = () => api;
    api.set = (value: Record<string, unknown>) => (sets.push(value), api);
    api.execute = async () => [];
    api.executeTakeFirst = async () => result;
    api.executeTakeFirstOrThrow = async () => ({ ...baseRequest, ...request, ...(sets.at(-1) ?? {}) });
    return api;
  };
  const trx = { selectFrom: () => mk({ ...baseRequest, ...request }), updateTable: () => mk(undefined) };
  const db = { transaction: () => ({ execute: async (fn: (t: typeof trx) => unknown) => fn(trx) }) };
  const ordersService = {
    createOrderInTransaction: createOrder,
    notifyLateAcceptedWithLocation: jest.fn().mockResolvedValue(undefined),
  };
  const notifications = { notifyNow: jest.fn().mockResolvedValue(undefined) };
  const cashRegister = { sessionIdForPayment: jest.fn().mockResolvedValue('register-1') };
  const service = new LateOrderRequestsService(db as never, ordersService as never, notifications as never, cashRegister as never);
  return { service, sets, ordersService, notifications };
}

const created = { id: 'order-1', orderNumber: 'ORD-0001' };
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('LateOrderRequestsService.accept con ubicación del checkout web', () => {
  it('pasa la ubicación guardada al crear el pedido (que la guarda y cotiza en la misma transacción)', async () => {
    const createOrder = jest.fn().mockResolvedValue(created);
    const { service } = createService({ delivery_latitude: point.latitude, delivery_longitude: point.longitude }, createOrder);

    await service.accept('req-1', 'staff');

    expect(createOrder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ channel: 'web', deliveryType: 'delivery', skipAvailabilityChecks: true, deliveryLocation: point }));
  });

  it('al aceptarse avisa el cobro / la cotización manual del pedido ya ubicado; NUNCA un location_request', async () => {
    const createOrder = jest.fn().mockResolvedValue(created);
    const { service, ordersService, notifications } = createService({ delivery_latitude: point.latitude, delivery_longitude: point.longitude }, createOrder);

    await service.accept('req-1', 'staff');
    await flush();

    expect(ordersService.notifyLateAcceptedWithLocation).toHaveBeenCalledWith('order-1');
    const kinds = notifications.notifyNow.mock.calls.map(([job]) => (job as { kind: string }).kind);
    expect(kinds).toEqual(['late_request_decision']);
  });

  it('SIN ubicación (solicitudes de siempre): deliveryLocation=null, nace awaiting_location y no hay avisos nuevos', async () => {
    const createOrder = jest.fn().mockResolvedValue(created);
    const { service, ordersService } = createService({ delivery_latitude: null, delivery_longitude: null }, createOrder);

    await service.accept('req-1', 'staff');
    await flush();

    expect(createOrder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deliveryLocation: null }));
    expect(ordersService.notifyLateAcceptedWithLocation).not.toHaveBeenCalled();
  });

  it('una fila de una base sin migrar (sin esas columnas) se trata como sin ubicación', async () => {
    const createOrder = jest.fn().mockResolvedValue(created);
    const { service } = createService({}, createOrder);

    await service.accept('req-1', 'staff');

    expect(createOrder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deliveryLocation: null }));
  });

  it('un fallo PERMANENTE del carrito (4xx) rechaza la solicitud y no avisa cobros', async () => {
    const createOrder = jest.fn().mockRejectedValue(new DomainException('product_unavailable', 409, 'caído'));
    const { service, sets, ordersService } = createService({ delivery_latitude: point.latitude, delivery_longitude: point.longitude }, createOrder);

    await expect(service.accept('req-1', 'staff')).rejects.toMatchObject({ code: 'order_unavailable' });

    expect(sets.some((value) => value.status === 'rejected')).toBe(true);
    expect(ordersService.notifyLateAcceptedWithLocation).not.toHaveBeenCalled();
  });

  it('un fallo 5xx al cotizar la ubicación (p. ej. falta el origen del local) NO rechaza la solicitud: se propaga y queda pendiente', async () => {
    const createOrder = jest.fn().mockRejectedValue(new DomainException('restaurant_location_not_configured', 500, 'Falta el origen'));
    const { service, sets, notifications } = createService({ delivery_latitude: point.latitude, delivery_longitude: point.longitude }, createOrder);

    await expect(service.accept('req-1', 'staff')).rejects.toMatchObject({ code: 'restaurant_location_not_configured' });

    expect(sets.some((value) => value.status === 'rejected')).toBe(false);
    expect(notifications.notifyNow).not.toHaveBeenCalled();
  });

  it('un error inesperado también se propaga sin rechazar', async () => {
    const createOrder = jest.fn().mockRejectedValue(new Error('boom'));
    const { service, sets } = createService({ delivery_latitude: point.latitude, delivery_longitude: point.longitude }, createOrder);

    await expect(service.accept('req-1', 'staff')).rejects.toThrow('boom');
    expect(sets.some((value) => value.status === 'rejected')).toBe(false);
  });

  it('aceptar de nuevo una solicitud ya aceptada no crea otro pedido ni repite avisos (idempotente)', async () => {
    const createOrder = jest.fn().mockResolvedValue(created);
    const { service, ordersService } = createService({ status: 'accepted', order_id: 'order-1', delivery_latitude: point.latitude, delivery_longitude: point.longitude }, createOrder);

    await expect(service.accept('req-1', 'staff')).resolves.toMatchObject({ id: 'req-1', orderId: 'order-1' });
    await flush();

    expect(createOrder).not.toHaveBeenCalled();
    expect(ordersService.notifyLateAcceptedWithLocation).not.toHaveBeenCalled();
  });
});
