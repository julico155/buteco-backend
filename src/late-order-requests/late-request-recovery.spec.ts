import { IdempotencyKeyReusedError, NotFoundDomainError, ValidationError } from '../common/exceptions/domain-exception';
import { hashRequestBody } from '../common/idempotency/idempotency.service';
import { ALL_AVAILABLE } from '../operational-settings/availability.fixtures';
import { idempotencyBody } from '../orders/delivery-location';
import { OrdersService } from '../orders/orders.service';
import { LateOrderRequestsService } from './late-order-requests.service';
import { httpStatusForLateRequest, toLateRequestState } from './late-request-state';

/**
 * M7A: recuperar de forma segura el resultado de un pedido fuera de horario (el 202 de `POST /orders`) tras una recarga o una
 * respuesta perdida: estado real en el reintento, clave por servicio, contenido verificado y consulta por teléfono.
 */

const baseRow = {
  id: 'req-1',
  request_number: 'SOL-000001',
  customer_id: 'customer-1',
  status: 'pending',
  subtotal_amount: '50.00',
  expires_at: new Date('2099-01-01T00:00:00Z'),
  order_id: null as string | null,
};

describe('toLateRequestState / httpStatusForLateRequest', () => {
  it('pendiente: el 202 de siempre, sin orderId ni orderNumber', () => {
    const state = toLateRequestState(baseRow, null);

    expect(state).toEqual({
      requestId: 'req-1',
      requestNumber: 'SOL-000001',
      status: 'pending',
      subtotalAmount: 50,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(httpStatusForLateRequest(state.status)).toBe(202);
  });

  it('aceptada: trae el pedido en que se convirtió y responde 200', () => {
    const state = toLateRequestState({ ...baseRow, status: 'accepted', order_id: 'order-9' }, 'ORD-0009');

    expect(state).toMatchObject({ status: 'accepted', orderId: 'order-9', orderNumber: 'ORD-0009' });
    expect(httpStatusForLateRequest(state.status)).toBe(200);
  });

  it.each(['rejected', 'expired'])('%s: definitiva, sin pedido, 200', (status) => {
    const state = toLateRequestState({ ...baseRow, status }, null);

    expect(state.status).toBe(status);
    expect(Object.keys(state)).not.toContain('orderId');
    expect(httpStatusForLateRequest(state.status)).toBe(200);
  });

  it('una pendiente que ya venció se informa como expirada aunque el barrido no haya pasado', () => {
    const state = toLateRequestState(
      { ...baseRow, expires_at: new Date('2026-10-06T16:20:00Z') },
      null,
      new Date('2026-10-06T16:21:00Z'),
    );

    expect(state.status).toBe('expired');
    expect(httpStatusForLateRequest(state.status)).toBe(200);
  });

  it('nunca expone nombre, teléfono ni carrito', () => {
    const state = toLateRequestState({ ...baseRow, status: 'accepted', order_id: 'o', customer_name: 'Ana', items_json: [] } as never, 'ORD-1');

    expect(JSON.stringify(state)).not.toMatch(/Ana|customer|items|phone/i);
  });
});

describe('LateOrderRequestsService.findByKey', () => {
  function createService(tables: { late?: Record<string, unknown>; customer?: Record<string, unknown>; order?: Record<string, unknown> }) {
    const wheres: Array<[string, string, unknown]> = [];
    const mk = (result: unknown) => {
      const api: Record<string, unknown> = {};
      for (const method of ['selectAll', 'select']) api[method] = () => api;
      api.where = (column: string, op: string, value: unknown) => (wheres.push([column, op, value]), api);
      api.executeTakeFirst = async () => result;
      return api;
    };
    const db = {
      selectFrom: (table: string) =>
        mk(table === 'late_order_requests' ? tables.late : table === 'customers' ? tables.customer : table === 'orders' ? tables.order : undefined),
    };
    const service = new LateOrderRequestsService(db as never, {} as never, {} as never, {} as never);
    return { service, wheres };
  }

  const phone = '+59170001234';

  it('con el teléfono del cliente dueño devuelve el estado', async () => {
    const { service } = createService({ late: baseRow, customer: { phone } });

    await expect(service.findByKey('whatsapp-gateway', 'key-1', phone)).resolves.toMatchObject({ requestId: 'req-1', status: 'pending' });
  });

  it('busca SOLO dentro de las solicitudes del servicio que llama', async () => {
    const { service, wheres } = createService({ late: baseRow, customer: { phone } });

    await service.findByKey('whatsapp-gateway', 'key-1', phone);

    expect(wheres).toEqual(expect.arrayContaining([
      ['api_client', '=', 'whatsapp-gateway'],
      ['idempotency_key', '=', 'key-1'],
    ]));
  });

  it('el teléfono se compara normalizado (con o sin +, espacios o guiones)', async () => {
    const { service } = createService({ late: baseRow, customer: { phone } });

    await expect(service.findByKey('whatsapp-gateway', 'key-1', '591 7000-1234')).resolves.toMatchObject({ requestId: 'req-1' });
  });

  it('aceptada: incluye el número del pedido', async () => {
    const { service } = createService({
      late: { ...baseRow, status: 'accepted', order_id: 'order-9' },
      customer: { phone },
      order: { order_number: 'ORD-0009' },
    });

    await expect(service.findByKey('whatsapp-gateway', 'key-1', phone)).resolves.toMatchObject({
      status: 'accepted',
      orderId: 'order-9',
      orderNumber: 'ORD-0009',
    });
  });

  it('teléfono de OTRA persona: 404, igual que si la clave no existiera', async () => {
    const { service } = createService({ late: baseRow, customer: { phone } });

    await expect(service.findByKey('whatsapp-gateway', 'key-1', '+59171112222')).rejects.toBeInstanceOf(NotFoundDomainError);
  });

  it('clave inexistente (o de otro servicio): 404', async () => {
    const { service } = createService({ late: undefined, customer: { phone } });

    await expect(service.findByKey('web', 'key-1', phone)).rejects.toBeInstanceOf(NotFoundDomainError);
  });

  it('solicitud sin cliente vinculado: no se puede verificar al dueño, 404', async () => {
    const { service } = createService({ late: { ...baseRow, customer_id: null }, customer: { phone } });

    await expect(service.findByKey('whatsapp-gateway', 'key-1', phone)).rejects.toBeInstanceOf(NotFoundDomainError);
  });

  it('sin teléfono: 400, no se consulta nada', async () => {
    const { service, wheres } = createService({ late: baseRow, customer: { phone } });

    await expect(service.findByKey('whatsapp-gateway', 'key-1', undefined)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.findByKey('whatsapp-gateway', 'key-1', '   ')).rejects.toBeInstanceOf(ValidationError);
    expect(wheres).toHaveLength(0);
  });
});

describe('createLateOrderRequest: reintento con la misma Idempotency-Key', () => {
  const dto = { customerName: 'Ana', channel: 'whatsapp', deliveryType: 'pickup', paymentMethod: 'cash', items: [{ productId: 'p1', quantity: 2 }], promotions: [] };
  const hashOf = (body: object) => hashRequestBody(idempotencyBody(body));

  function createService(existing: Record<string, unknown> | undefined, order?: Record<string, unknown>) {
    const wheres: Array<[string, string, unknown]> = [];
    const inserted: Array<Record<string, unknown>> = [];
    const mk = (result: unknown) => {
      const api: Record<string, unknown> = {};
      for (const method of ['selectAll', 'select', 'onConflict', 'returningAll']) api[method] = () => api;
      api.where = (column: string, op: string, value: unknown) => (wheres.push([column, op, value]), api);
      api.values = (value: Record<string, unknown>) => (inserted.push(value), api);
      api.execute = async () => (Array.isArray(result) ? result : []);
      api.executeTakeFirst = async () => result;
      api.executeTakeFirstOrThrow = async () => result;
      return api;
    };
    const db = {
      selectFrom: (table: string) => mk(table === 'late_order_requests' ? existing : table === 'orders' ? order : []),
      insertInto: () => mk(undefined),
    };
    const service = new OrdersService(
      db as never, {} as never,
      { getRow: jest.fn().mockResolvedValue({ business_opens_hour: 0, business_closes_hour: 23, ...ALL_AVAILABLE }) } as never,
      {} as never, { notifyNow: jest.fn() } as never, {} as never, {} as never,
      { get: jest.fn(() => 20) } as never, {} as never, { resolve: jest.fn().mockResolvedValue(null) } as never,
    );
    const call = (body: object, apiClient = 'whatsapp-gateway') =>
      (service as unknown as {
        createLateOrderRequest(dto: unknown, key: string, now: Date, location: unknown, apiClient: string): Promise<Record<string, unknown>>;
      }).createLateOrderRequest(body, 'late-key', new Date('2026-10-06T16:00:00Z'), null, apiClient);
    return { call, wheres, inserted };
  }

  const stored = { id: 'req-1', request_number: 'SOL-000001', subtotal_amount: '50.00', expires_at: new Date('2099-01-01T00:00:00Z'), order_id: null };

  it('misma clave y mismo contenido: devuelve la solicitud, sin crear otra', async () => {
    const { call, inserted } = createService({ ...stored, status: 'pending', request_hash: hashOf(dto) });

    await expect(call(dto)).resolves.toMatchObject({ requestId: 'req-1', status: 'pending' });
    expect(inserted).toHaveLength(0);
  });

  it('si el local ya la aceptó, el reintento devuelve el pedido en que se convirtió (no un "pending" viejo)', async () => {
    const { call } = createService({ ...stored, status: 'accepted', order_id: 'order-9', request_hash: hashOf(dto) }, { order_number: 'ORD-0009' });

    await expect(call(dto)).resolves.toMatchObject({ status: 'accepted', orderId: 'order-9', orderNumber: 'ORD-0009' });
  });

  it('si el local la rechazó, el reintento informa rejected', async () => {
    const { call } = createService({ ...stored, status: 'rejected', request_hash: hashOf(dto) });

    await expect(call(dto)).resolves.toMatchObject({ status: 'rejected' });
  });

  it('misma clave con OTRO carrito: 409 idempotency_key_reused, no devuelve la solicitud vieja', async () => {
    const { call, inserted } = createService({ ...stored, status: 'pending', request_hash: hashOf(dto) });

    await expect(call({ ...dto, items: [{ productId: 'p1', quantity: 3 }] })).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    expect(inserted).toHaveLength(0);
  });

  it('la búsqueda es por (servicio, clave): otro servicio con la misma clave no ve esta solicitud', async () => {
    const { call, wheres } = createService({ ...stored, status: 'pending', request_hash: hashOf(dto) });

    await call(dto, 'whatsapp-gateway');

    expect(wheres).toEqual(expect.arrayContaining([['api_client', '=', 'whatsapp-gateway'], ['idempotency_key', '=', 'late-key']]));
  });

  it('una solicitud anterior a la migración (sin huella) sigue respondiendo con la comparación de ubicación de siempre', async () => {
    const { call } = createService({ ...stored, status: 'pending', request_hash: null });

    await expect(call(dto)).resolves.toMatchObject({ requestId: 'req-1' });
  });
});
