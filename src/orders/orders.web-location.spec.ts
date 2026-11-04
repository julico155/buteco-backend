import { DomainException, IdempotencyKeyReusedError } from '../common/exceptions/domain-exception';
import { ALL_AVAILABLE } from '../operational-settings/availability.fixtures';
import { OrderResponse, OrdersService } from './orders.service';

/**
 * NO se ha ejecutado todavía. Pedido de delivery del checkout web con la ubicación incluida al crear:
 *   - se guarda y se cotiza DENTRO de la transacción que crea el pedido (nunca existe un pedido a medias),
 *   - nadie manda `location_request` (la carrera "avisar antes de adjuntar" queda cerrada),
 *   - los pedidos de siempre no cambian.
 * La atomicidad real y la concurrencia solo las demuestra PostgreSQL (ver test/web-location.e2e-spec.ts).
 */
beforeEach(() => {
  jest.useFakeTimers({
    now: new Date('2026-10-06T16:00:00Z'),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
});
afterEach(() => {
  jest.useRealTimers();
});

const point = { latitude: -17.7833, longitude: -63.1821 };

const insertedRow = {
  id: 'order-1',
  order_number: 'ORD-0001',
  customer_id: 'customer-1',
  channel: 'web',
  customer_name: 'Ana',
  delivery_type: 'delivery',
  payment_method: 'cash',
  qr_scope: null,
  payment_status: 'unpaid',
  notes: null,
  status: 'awaiting_location',
  subtotal_amount: '50.00',
  delivery_base_amount: '0.00',
  delivery_surcharge_amount: '0.00',
  total_amount: '50.00',
  delivery_quote_status: 'pending',
  delivery_distance_meters: null,
  cash_confirmed_at: null,
  split_cash_amount: null,
  split_qr_amount: null,
  split_cash_confirmed_at: null,
  status_updated_by: null,
  delivery_driver_name: null,
  delivery_accepted_at: null,
  delivered_at: null,
  created_at: new Date('2026-10-06T16:00:00Z'),
  updated_at: new Date('2026-10-06T16:00:00Z'),
};
const quotedRow = { ...insertedRow, status: 'confirmed', delivery_quote_status: 'quoted', delivery_base_amount: '10.00', delivery_surcharge_amount: '2.00', total_amount: '62.00', delivery_distance_meters: 3200 };
const manualRow = { ...insertedRow, delivery_quote_status: 'pending_manual', delivery_distance_meters: 21000 };

/** Transacción falsa que anota qué se escribió y en qué orden, junto con la cotización. */
function fakeTrx(log: string[], rows: { inserted: Record<string, unknown>; final: Record<string, unknown> }) {
  const ops: Array<{ op: string; table: string; payload?: unknown }> = [];
  const builder = (op: string, table: string) => {
    const state: { payload?: unknown } = {};
    const api: Record<string, unknown> = {};
    for (const method of ['where', 'selectAll', 'select', 'returningAll', 'orderBy', 'forUpdate', 'onConflict']) api[method] = () => api;
    api.values = (value: unknown) => ((state.payload = value), api);
    api.set = (value: unknown) => ((state.payload = value), api);
    const finish = async () => {
      log.push(`${op}:${table}`);
      ops.push({ op, table, payload: state.payload });
      if (op === 'insert' && table === 'orders') return rows.inserted;
      if (op === 'select' && table === 'orders') return rows.final;
      return op === 'select' ? [] : undefined;
    };
    api.execute = async () => {
      const result = await finish();
      return Array.isArray(result) ? result : result === undefined ? [] : [result];
    };
    api.executeTakeFirst = finish;
    api.executeTakeFirstOrThrow = finish;
    return api;
  };
  const trx = {
    insertInto: (table: string) => builder('insert', table),
    updateTable: (table: string) => builder('update', table),
    selectFrom: (table: string) => builder('select', table),
  };
  return { trx, ops };
}

function createService(overrides: { quote?: jest.Mock; idempotencyRun?: jest.Mock } = {}) {
  const log: string[] = [];
  const quote = overrides.quote ?? jest.fn(async () => {
    log.push('quote');
    return { result: 'applied' };
  });
  const deliveryService = { quoteForOrderInTransaction: quote };
  const notifications = { notifyNow: jest.fn().mockResolvedValue(undefined) };
  const deliveryNotices = { notifyConfirmed: jest.fn().mockResolvedValue(undefined) };
  const qrPayments = { generateForOrder: jest.fn().mockResolvedValue({ qrImageUrl: 'https://qr.example/img.png' }) };
  const idempotency = { run: overrides.idempotencyRun ?? jest.fn() };
  const operationalSettings = { getRow: jest.fn().mockResolvedValue({ business_opens_hour: 0, business_closes_hour: 23, ...ALL_AVAILABLE, channel_external_enabled: true }) };
  const cashRegister = { isOpen: jest.fn().mockResolvedValue(true) };
  const config = { get: jest.fn((key: string) => (key === 'aiTestPhones' ? [] : key === 'unpaidOrderTtlMinutes' ? 20 : key === 'lateOrderRequestTtlMinutes' ? 20 : 'bank')) };
  const service = new OrdersService(
    {} as never,
    idempotency as never,
    operationalSettings as never,
    deliveryService as never,
    notifications as never,
    cashRegister as never,
    qrPayments as never,
    config as never,
    deliveryNotices as never,
    { resolve: jest.fn().mockResolvedValue(null) } as never,
  );
  jest.spyOn(service, 'priceCart').mockResolvedValue({
    itemLines: [{ product: { id: 'p1', code: 'P1', name: 'Hamburguesa', price: '25.00', serves_label: null, prep_minutes: null }, quantity: 2, unitPrice: 25, subtotal: 50, excludedComplements: [], selectedOptions: [] }],
    promotionLines: [],
    subtotal: 50,
    now: new Date('2026-10-06T16:00:00Z'),
  } as never);
  jest.spyOn(service, 'assignOrderNumber').mockResolvedValue({ orderNumber: 'ORD-0001', numberingSessionId: null });
  return { service, log, quote, notifications, deliveryNotices, qrPayments, idempotency };
}

const input = {
  customerId: null,
  channel: 'web' as const,
  customerName: 'Ana',
  deliveryType: 'delivery' as const,
  paymentMethod: 'cash' as const,
  skipAvailabilityChecks: true,
  notes: null,
  items: [{ productId: 'p1', quantity: 2 }],
  promotions: [],
};

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as DomainException).code;
  }
  throw new Error('debía lanzar');
}

describe('createOrderInTransaction con la ubicación del checkout web', () => {
  it('guarda las coordenadas y cotiza en la MISMA transacción, en ese orden, y devuelve el pedido ya cotizado', async () => {
    const { service, log, quote } = createService();
    const { trx, ops } = fakeTrx(log, { inserted: insertedRow, final: quotedRow });

    const order = await service.createOrderInTransaction(trx as never, { ...input, deliveryLocation: point });

    expect(log).toEqual(['insert:orders', 'insert:order_items', 'update:orders', 'quote', 'select:orders', 'select:order_items', 'select:order_promotions']);
    expect(ops.find((op) => op.op === 'update')?.payload).toMatchObject({ delivery_latitude: point.latitude, delivery_longitude: point.longitude });
    expect(quote).toHaveBeenCalledTimes(1);
    expect(order).toMatchObject({ status: 'confirmed', deliveryQuoteStatus: 'quoted', deliveryBaseAmount: 10, deliverySurchargeAmount: 2, totalAmount: 62, deliveryDistanceMeters: 3200 });
  });

  it('la cotización la hace Central con el pedido recién creado: no recibe ningún importe, subtotal ni tarifa del navegador', async () => {
    const { service, log, quote } = createService();
    const { trx } = fakeTrx(log, { inserted: insertedRow, final: quotedRow });

    await service.createOrderInTransaction(trx as never, { ...input, deliveryLocation: point });

    // (transacción, id del pedido): nada más. El subtotal sale de la fila del pedido, calculado desde el catálogo.
    expect(quote).toHaveBeenCalledWith(trx, 'order-1');
    expect(quote.mock.calls[0]).toHaveLength(2);
  });

  it('el total que se devuelve es el de la fila ya cotizada (subtotal + envío + recargo UNA vez), no el provisional', async () => {
    const { service, log } = createService();
    const { trx } = fakeTrx(log, { inserted: insertedRow, final: quotedRow });

    const order = await service.createOrderInTransaction(trx as never, { ...input, deliveryLocation: point });

    expect(order.totalAmount).toBe(order.subtotalAmount + order.deliveryBaseAmount + order.deliverySurchargeAmount);
    expect(order.totalAmount).not.toBe(50);
  });

  it('por encima del techo automático: queda awaiting_location + pending_manual, con distancia y SIN importe de delivery', async () => {
    const quote = jest.fn(async () => ({ result: 'pending_manual' }));
    const { service, log } = createService({ quote });
    const { trx } = fakeTrx(log, { inserted: insertedRow, final: manualRow });

    const order = await service.createOrderInTransaction(trx as never, { ...input, deliveryLocation: point });

    expect(order).toMatchObject({ status: 'awaiting_location', deliveryQuoteStatus: 'pending_manual', deliveryDistanceMeters: 21000, deliveryBaseAmount: 0, totalAmount: 50 });
  });

  it('si la cotización falla, la excepción se propaga (la transacción entera se revierte): nunca un pedido con envío gratis', async () => {
    const quote = jest.fn(async () => {
      throw new DomainException('restaurant_location_not_configured', 500, 'Faltan las coordenadas del restaurante.');
    });
    const { service, log } = createService({ quote });
    const { trx } = fakeTrx(log, { inserted: insertedRow, final: quotedRow });

    await expect(service.createOrderInTransaction(trx as never, { ...input, deliveryLocation: point })).rejects.toMatchObject({ code: 'restaurant_location_not_configured' });
    expect(log).not.toContain('select:orders');
  });

  it('SIN ubicación (clientes de siempre): no se guarda ni se cotiza nada y el pedido nace awaiting_location', async () => {
    const { service, log, quote } = createService();
    const { trx } = fakeTrx(log, { inserted: insertedRow, final: quotedRow });

    const order = await service.createOrderInTransaction(trx as never, { ...input });
    await service.createOrderInTransaction(trx as never, { ...input, deliveryLocation: null });

    expect(quote).not.toHaveBeenCalled();
    expect(log).not.toContain('update:orders');
    expect(order).toMatchObject({ status: 'awaiting_location', deliveryQuoteStatus: 'pending', totalAmount: 50 });
  });

  it.each(['web', 'whatsapp'] as const)('3. el canal %s (con servicio autorizado) la guarda y cotiza, y el pedido conserva ese canal', async (channel) => {
    const { service, log, quote } = createService();
    const { trx } = fakeTrx(log, { inserted: { ...insertedRow, channel }, final: { ...quotedRow, channel } });

    const order = await service.createOrderInTransaction(trx as never, { ...input, channel, deliveryLocation: point });

    expect(quote).toHaveBeenCalledTimes(1);
    expect(order).toMatchObject({ channel, status: 'confirmed', deliveryQuoteStatus: 'quoted' });
  });

  it.each(['pos', 'external'] as const)('el canal %s no puede mandarla: se rechaza ANTES de escribir nada', async (channel) => {
    const { service, log, quote } = createService();
    const { trx } = fakeTrx(log, { inserted: insertedRow, final: quotedRow });

    expect(await codeOf(service.createOrderInTransaction(trx as never, { ...input, channel, deliveryLocation: point }))).toBe('delivery_location_not_supported');
    expect(log).toEqual([]);
    expect(quote).not.toHaveBeenCalled();
  });

  it('pickup con ubicación se rechaza antes de escribir', async () => {
    const { service, log } = createService();
    const { trx } = fakeTrx(log, { inserted: insertedRow, final: quotedRow });

    expect(await codeOf(service.createOrderInTransaction(trx as never, { ...input, deliveryType: 'pickup', deliveryLocation: point }))).toBe('validation_error');
    expect(log).toEqual([]);
  });

  it.each([
    ['latitud fuera de rango', { latitude: 95, longitude: 0 }],
    ['longitud NaN', { latitude: 0, longitude: Number.NaN }],
  ])('coordenadas inválidas (%s): error controlado antes de crear un estado inconsistente', async (_name, deliveryLocation) => {
    const { service, log } = createService();
    const { trx } = fakeTrx(log, { inserted: insertedRow, final: quotedRow });

    expect(await codeOf(service.createOrderInTransaction(trx as never, { ...input, deliveryLocation }))).toBe('validation_error');
    expect(log).toEqual([]);
  });
});

describe('OrdersService.create con deliveryLocation', () => {
  const dto = {
    customerName: 'Ana',
    channel: 'web' as const,
    deliveryType: 'delivery' as const,
    paymentMethod: 'cash' as const,
    items: [{ productId: 'p1', quantity: 2 }],
  };
  const body = { ...({} as OrderResponse), id: 'order-1', customerId: 'customer-1' };

  function withIdempotency(created = true) {
    const run = jest.fn(async () => ({ created, body, status: 201 }));
    const ctx = createService({ idempotencyRun: run });
    const notify = jest.spyOn(ctx.service, 'notifyOrderCreated').mockResolvedValue(undefined);
    return { ...ctx, run, notify };
  }

  it.each([
    ['5. POS', 'pos', 'pos', 'delivery_location_not_supported'],
    ['6. external (delivery ya está prohibido en ese canal)', 'external', 'external', 'validation_error'],
  ] as const)('%s la rechaza antes de tocar la idempotencia', async (_name, apiClient, channel, code) => {
    const { service, run } = withIdempotency();

    expect(await codeOf(service.create({ ...dto, channel, deliveryLocation: point }, 'idem-1', apiClient))).toBe(code);
    expect(run).not.toHaveBeenCalled();
  });

  it('4. un api_client no autorizado que produjera canal whatsapp no hereda el permiso: se rechaza antes de la idempotencia', async () => {
    const { service, run } = withIdempotency();

    expect(await codeOf(service.create({ ...dto, channel: 'whatsapp', deliveryLocation: point }, 'idem-1', 'otro-gateway'))).toBe('delivery_location_not_supported');
    expect(run).not.toHaveBeenCalled();
  });

  it('un body con channel web pero la credencial equivocada no gana permiso (el controlador ya fija el canal por credencial)', async () => {
    const { service, run } = withIdempotency();

    expect(await codeOf(service.create({ ...dto, channel: 'web', deliveryLocation: point }, 'idem-1', 'whatsapp-gateway'))).toBe('delivery_location_not_supported');
    expect(run).not.toHaveBeenCalled();
  });

  it('1/2. web y whatsapp-gateway (cada uno con SU canal) llegan hasta la idempotencia; el canal NO cambia', async () => {
    for (const [apiClient, channel] of [['web', 'web'], ['whatsapp-gateway', 'whatsapp']] as const) {
      const { service, run } = withIdempotency();

      await service.create({ ...dto, channel, deliveryLocation: point }, `idem-${apiClient}`, apiClient);

      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ apiClient, requestBody: expect.objectContaining({ channel, deliveryLocation: point }) }));
    }
  });

  it('9. un pedido tradicional de WhatsApp (sin ubicación) funciona igual: sin clave nueva en el hash y locationProvided=false', async () => {
    const { service, run, notify } = withIdempotency(true);

    await service.create({ ...dto, channel: 'whatsapp' }, 'idem-1', 'whatsapp-gateway');
    await new Promise((resolve) => setImmediate(resolve));

    const requestBody = (run.mock.calls as unknown as Array<[{ requestBody: object }]>)[0][0].requestBody;
    expect(Object.keys(requestBody)).not.toContain('deliveryLocation');
    expect(notify).toHaveBeenCalledWith(body, { locationProvided: false });
  });

  it('12. whatsapp-gateway con ubicación: la creación real avisa con locationProvided=true; el reintento idempotente (200) no avisa', async () => {
    const created = withIdempotency(true);
    await created.service.create({ ...dto, channel: 'whatsapp', deliveryLocation: point }, 'idem-1', 'whatsapp-gateway');
    await new Promise((resolve) => setImmediate(resolve));
    expect(created.notify).toHaveBeenCalledWith(body, { locationProvided: true });

    const replay = withIdempotency(false);
    const result = await replay.service.create({ ...dto, channel: 'whatsapp', deliveryLocation: point }, 'idem-1', 'whatsapp-gateway');
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.httpStatus).toBe(200);
    expect(replay.notify).not.toHaveBeenCalled();
  });

  it('pickup con ubicación se rechaza antes de la idempotencia', async () => {
    const { service, run } = withIdempotency();

    expect(await codeOf(service.create({ ...dto, deliveryType: 'pickup', deliveryLocation: point }, 'idem-1', 'web'))).toBe('validation_error');
    expect(run).not.toHaveBeenCalled();
  });

  it('la ubicación forma parte del cuerpo idempotente: otra ubicación con la misma clave es otro cuerpo (el servicio de idempotencia responde 409 idempotency_key_reused)', async () => {
    const { service, run } = withIdempotency();

    await service.create({ ...dto, deliveryLocation: point }, 'idem-1', 'web');
    await service.create({ ...dto, deliveryLocation: { latitude: -17.9, longitude: -63.3 } }, 'idem-1', 'web');

    const bodies = (run.mock.calls as unknown as Array<[{ requestBody: { deliveryLocation?: unknown } }]>).map(([params]) => params.requestBody.deliveryLocation);
    expect(bodies).toEqual([point, { latitude: -17.9, longitude: -63.3 }]);
  });

  it('creación real con ubicación: avisa con locationProvided=true', async () => {
    const { service, notify } = withIdempotency(true);

    const result = await service.create({ ...dto, deliveryLocation: point }, 'idem-1', 'web');
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.httpStatus).toBe(201);
    expect(notify).toHaveBeenCalledWith(body, { locationProvided: true });
  });

  it('creación real SIN ubicación: locationProvided=false (comportamiento de siempre)', async () => {
    const { service, notify } = withIdempotency(true);

    await service.create({ ...dto }, 'idem-1', 'web');
    await new Promise((resolve) => setImmediate(resolve));

    expect(notify).toHaveBeenCalledWith(body, { locationProvided: false });
  });

  it('un REINTENTO idempotente (respuesta ya guardada) responde 200 y no vuelve a avisar nada', async () => {
    const { service, notify } = withIdempotency(false);

    const result = await service.create({ ...dto, deliveryLocation: point }, 'idem-1', 'web');
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.httpStatus).toBe(200);
    expect(notify).not.toHaveBeenCalled();
  });

  it('INTEGRADO: una creación web ubicada y cotizada nunca emite location_request (cierra la carrera con WhatsApp)', async () => {
    const response: OrderResponse = {
      id: 'order-1', orderNumber: 'ORD-0001', customerId: 'customer-1', channel: 'web', customerName: 'Ana', deliveryType: 'delivery',
      tableId: null, billRequestedAt: null, depositCreditAmount: 0, paymentMethod: 'cash', qrScope: null, paymentStatus: 'unpaid', status: 'confirmed', notes: null,
      subtotalAmount: 50, deliveryBaseAmount: 10, deliverySurchargeAmount: 2, totalAmount: 62, deliveryQuoteStatus: 'quoted', deliveryDistanceMeters: 3200,
      cashConfirmedAt: null, splitCashAmount: null, splitQrAmount: null, splitCashConfirmedAt: null, statusUpdatedBy: null, deliveryDriverName: null,
      deliveryAcceptedAt: null, deliveredAt: null, createdAt: '2026-10-06T16:00:00.000Z', updatedAt: '2026-10-06T16:00:00.000Z', items: [], promotions: [],
    };
    const ctx = createService({ idempotencyRun: jest.fn(async () => ({ created: true, body: response, status: 201 })) });

    await ctx.service.create({ ...dto, deliveryLocation: point }, 'idem-1', 'web');
    await new Promise((resolve) => setImmediate(resolve));

    const kinds = ctx.notifications.notifyNow.mock.calls.map(([job]) => (job as { kind: string }).kind);
    expect(kinds).not.toContain('location_request');
    expect(kinds).toEqual(['order_received', 'cash_on_delivery_confirmation']);
    expect(ctx.deliveryNotices.notifyConfirmed).toHaveBeenCalledWith('order-1');
  });
});

describe('OrdersService.notifyOrderCreated con ubicación incluida', () => {
  const base: OrderResponse = {
    id: 'order-1', orderNumber: 'ORD-0001', customerId: 'customer-1', channel: 'web', customerName: 'Ana', deliveryType: 'delivery',
    tableId: null, billRequestedAt: null, depositCreditAmount: 0, paymentMethod: 'cash', qrScope: null, paymentStatus: 'unpaid', status: 'confirmed', notes: null,
    subtotalAmount: 50, deliveryBaseAmount: 10, deliverySurchargeAmount: 2, totalAmount: 62, deliveryQuoteStatus: 'quoted', deliveryDistanceMeters: 3200,
    cashConfirmedAt: null, splitCashAmount: null, splitQrAmount: null, splitCashConfirmedAt: null, statusUpdatedBy: null, deliveryDriverName: null,
    deliveryAcceptedAt: null, deliveredAt: null, createdAt: '2026-10-06T16:00:00.000Z', updatedAt: '2026-10-06T16:00:00.000Z', items: [], promotions: [],
  };
  const kindsOf = (notifications: { notifyNow: jest.Mock }) => notifications.notifyNow.mock.calls.map(([job]) => (job as { kind: string }).kind);

  it('cotizado + efectivo: order_received y el aviso de cobro con el total FINAL; ningún location_request; aviso al grupo de reparto', async () => {
    const { service, notifications, deliveryNotices } = createService();

    await service.notifyOrderCreated(base, { locationProvided: true });

    expect(kindsOf(notifications)).toEqual(['order_received', 'cash_on_delivery_confirmation']);
    const cash = notifications.notifyNow.mock.calls[1][0] as { payload: { context: Record<string, number> } };
    expect(cash.payload.context).toMatchObject({ subtotalAmount: 50, deliveryBaseAmount: 10, deliverySurchargeAmount: 2, deliveryAmount: 12, totalAmount: 62 });
    expect(deliveryNotices.notifyConfirmed).toHaveBeenCalledWith('order-1');
  });

  it('cotizado + QR: genera el QR real con el total final y no pide ubicación', async () => {
    const { service, notifications, qrPayments } = createService();

    await service.notifyOrderCreated({ ...base, paymentMethod: 'qr' }, { locationProvided: true });

    expect(qrPayments.generateForOrder).toHaveBeenCalledWith('order-1');
    expect(kindsOf(notifications)).toEqual(['order_received', 'qr_confirmation']);
  });

  it('pending_manual: order_received y una alerta al personal; NO hay location_request, ni cobro, ni aviso de reparto', async () => {
    const { service, notifications, deliveryNotices, qrPayments } = createService();

    await service.notifyOrderCreated({ ...base, status: 'awaiting_location', deliveryQuoteStatus: 'pending_manual', deliveryBaseAmount: 0, deliverySurchargeAmount: 0, totalAmount: 50, deliveryDistanceMeters: 21000 }, { locationProvided: true });

    expect(kindsOf(notifications)).toEqual(['order_received', 'manual_quote_alert']);
    expect(qrPayments.generateForOrder).not.toHaveBeenCalled();
    expect(deliveryNotices.notifyConfirmed).not.toHaveBeenCalled();
    const alert = notifications.notifyNow.mock.calls[1][0] as { channel: string; payload: { text: string; chatRef: string } };
    expect(alert.channel).toBe('telegram');
    expect(alert.payload.text).toContain('ORD-0001');
    // Sin coordenadas ni datos del cliente en la alerta.
    expect(alert.payload.text).not.toMatch(/17\.78|63\.18|Ana|customer/);
  });

  it('SIN la bandera (pedido de WhatsApp, o un cliente anterior) un delivery awaiting_location sigue pidiendo la ubicación', async () => {
    const { service, notifications } = createService();

    await service.notifyOrderCreated({ ...base, channel: 'whatsapp', status: 'awaiting_location', deliveryQuoteStatus: 'pending' });
    await service.notifyOrderCreated({ ...base, status: 'awaiting_location', deliveryQuoteStatus: 'pending' }, { locationProvided: false });

    expect(kindsOf(notifications)).toEqual(['location_request', 'location_request']);
  });

  it('con la bandera pero SIN que el pedido haya quedado ubicado (estado inconsistente): cae a pedir la ubicación, no deja al cliente sin aviso', async () => {
    const { service, notifications } = createService();

    await service.notifyOrderCreated({ ...base, status: 'awaiting_location', deliveryQuoteStatus: 'pending' }, { locationProvided: true });

    expect(kindsOf(notifications)).toEqual(['location_request']);
  });

  it('la bandera no cambia nada para pickup: sus avisos de siempre y sin aviso de reparto', async () => {
    const { service, notifications, deliveryNotices } = createService();

    await service.notifyOrderCreated({ ...base, deliveryType: 'pickup', deliveryQuoteStatus: null, deliveryBaseAmount: 0, deliverySurchargeAmount: 0, totalAmount: 50 }, { locationProvided: true });

    expect(kindsOf(notifications)).toEqual(['order_received', 'cash_on_delivery_confirmation']);
    expect(deliveryNotices.notifyConfirmed).not.toHaveBeenCalled();
  });

  it('un pedido sin cliente o del canal external no avisa nada', async () => {
    const { service, notifications } = createService();

    await service.notifyOrderCreated({ ...base, customerId: null }, { locationProvided: true });
    await service.notifyOrderCreated({ ...base, channel: 'external' }, { locationProvided: true });

    expect(notifications.notifyNow).not.toHaveBeenCalled();
  });

  it('un fallo del gateway al avisar no rompe nada (best-effort) y no inventa un location_request', async () => {
    const { service, notifications } = createService();
    notifications.notifyNow.mockRejectedValue(new Error('gateway down'));

    await expect(service.notifyOrderCreated(base, { locationProvided: true })).resolves.toBeUndefined();
    expect(kindsOf(notifications)).not.toContain('location_request');
  });
});

describe('notifyLateAcceptedWithLocation (solicitud tardía aceptada con ubicación)', () => {
  const quotedOrder = { id: 'order-1', status: 'confirmed', deliveryQuoteStatus: 'quoted' } as OrderResponse;

  it('cotizado: dispara el cobro y el aviso de reparto (sendQrConfirmationAfterQuote)', async () => {
    const { service } = createService();
    jest.spyOn(service, 'findById').mockResolvedValue(quotedOrder);
    const after = jest.spyOn(service, 'sendQrConfirmationAfterQuote').mockResolvedValue(undefined);

    await service.notifyLateAcceptedWithLocation('order-1');

    expect(after).toHaveBeenCalledWith('order-1');
  });

  it('pending_manual: solo la alerta al personal', async () => {
    const { service, notifications } = createService();
    jest.spyOn(service, 'findById').mockResolvedValue({ ...quotedOrder, orderNumber: 'ORD-0001', status: 'awaiting_location', deliveryQuoteStatus: 'pending_manual', deliveryDistanceMeters: 21000, subtotalAmount: 50 } as OrderResponse);
    const after = jest.spyOn(service, 'sendQrConfirmationAfterQuote').mockResolvedValue(undefined);

    await service.notifyLateAcceptedWithLocation('order-1');

    expect(after).not.toHaveBeenCalled();
    expect(notifications.notifyNow).toHaveBeenCalledWith(expect.objectContaining({ channel: 'telegram', kind: 'manual_quote_alert' }));
  });

  it('cualquier otro estado: no avisa nada', async () => {
    const { service, notifications } = createService();
    jest.spyOn(service, 'findById').mockResolvedValue({ ...quotedOrder, status: 'awaiting_location', deliveryQuoteStatus: 'pending' } as OrderResponse);

    await service.notifyLateAcceptedWithLocation('order-1');

    expect(notifications.notifyNow).not.toHaveBeenCalled();
  });
});

/** HTTP 202: la solicitud guarda la ubicación para materializarla al aceptarse. */
describe('createLateOrderRequest con ubicación (HTTP 202)', () => {
  function lateService(existing?: Record<string, unknown>) {
    const inserted: Array<Record<string, unknown>> = [];
    const row = { id: 'req-1', request_number: 'SOL-000001', subtotal_amount: '50.00', expires_at: new Date('2026-10-06T16:20:00Z'), customer_name: 'Ana' };
    const mk = (result: unknown) => {
      const api: Record<string, unknown> = {};
      for (const method of ['selectAll', 'select', 'where', 'onConflict', 'returningAll']) api[method] = () => api;
      api.values = (value: Record<string, unknown>) => (inserted.push(value), api);
      api.execute = async () => (Array.isArray(result) ? result : []);
      api.executeTakeFirst = async () => result;
      api.executeTakeFirstOrThrow = async () => result;
      return api;
    };
    const db = {
      selectFrom: (table: string) => mk(table === 'late_order_requests' ? existing : table === 'products' ? [{ id: 'p1', price: '25.00' }] : []),
      insertInto: () => mk({ ...row, delivery_latitude: null, delivery_longitude: null }),
    };
    const ctx = createService();
    const service = new OrdersService(
      db as never, {} as never,
      { getRow: jest.fn().mockResolvedValue({ business_opens_hour: 0, business_closes_hour: 23, ...ALL_AVAILABLE }) } as never,
      {} as never, ctx.notifications as never, {} as never, {} as never,
      { get: jest.fn(() => 20) } as never, {} as never, { resolve: jest.fn().mockResolvedValue(null) } as never,
    );
    const call = (location: { latitude: number; longitude: number } | null, channel: 'web' | 'whatsapp' = 'web') =>
      (service as unknown as { createLateOrderRequest(dto: unknown, key: string, now: Date, location: unknown): Promise<unknown> }).createLateOrderRequest(
        { customerName: 'Ana', channel, deliveryType: 'delivery', paymentMethod: 'cash', items: [{ productId: 'p1', quantity: 2 }], promotions: [] },
        'late-key', new Date('2026-10-06T16:00:00Z'), location,
      );
    return { call, inserted, notifications: ctx.notifications };
  }

  it('con ubicación: la guarda junto a la solicitud (y NO existe aún ningún pedido ni cotización)', async () => {
    const { call, inserted } = lateService();

    await call(point);

    expect(inserted[0]).toMatchObject({ delivery_latitude: point.latitude, delivery_longitude: point.longitude, channel: 'web', delivery_type: 'delivery' });
  });

  it('11. whatsapp-gateway con ubicación: la solicitud 202 guarda las coordenadas y conserva channel whatsapp', async () => {
    const { call, inserted } = lateService();

    const response = await call(point, 'whatsapp');

    expect(inserted[0]).toMatchObject({ delivery_latitude: point.latitude, delivery_longitude: point.longitude, channel: 'whatsapp', delivery_type: 'delivery' });
    // El contrato 202 de M6A no cambia: ni coordenadas ni orderId.
    expect(Object.keys(response as object).sort()).toEqual(['expiresAt', 'requestId', 'requestNumber', 'status', 'subtotalAmount']);
  });

  it('sin ubicación: no toca las columnas nuevas (funciona aun sin la migración)', async () => {
    const { call, inserted } = lateService();

    await call(null);

    expect(Object.keys(inserted[0])).not.toContain('delivery_latitude');
    expect(Object.keys(inserted[0])).not.toContain('delivery_longitude');
  });

  it('la respuesta 202 no incluye coordenadas ni afirma que exista un pedido', async () => {
    const { call } = lateService();

    const response = await call(point);

    expect(Object.keys(response as object).sort()).toEqual(['expiresAt', 'requestId', 'requestNumber', 'status', 'subtotalAmount']);
    expect(JSON.stringify(response)).not.toMatch(/17\.78|63\.18|orderId/);
  });

  it('reintento con la MISMA ubicación: devuelve la solicitud ya guardada', async () => {
    const { call, inserted } = lateService({ id: 'req-1', request_number: 'SOL-000001', subtotal_amount: '50.00', expires_at: new Date(), delivery_latitude: point.latitude, delivery_longitude: point.longitude });

    await expect(call(point)).resolves.toMatchObject({ requestId: 'req-1' });
    expect(inserted).toHaveLength(0);
  });

  it('reintento con OTRA ubicación: 409 idempotency_key_reused, nada cambia en silencio', async () => {
    const { call, inserted } = lateService({ id: 'req-1', request_number: 'SOL-000001', subtotal_amount: '50.00', expires_at: new Date(), delivery_latitude: point.latitude, delivery_longitude: point.longitude });

    await expect(call({ latitude: -17.9, longitude: -63.3 })).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    await expect(call(null)).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    expect(inserted).toHaveLength(0);
  });

  it('12. whatsapp-gateway: reintento con OTRA ubicación sigue siendo 409 idempotency_key_reused', async () => {
    const { call, inserted } = lateService({ id: 'req-1', request_number: 'SOL-000001', subtotal_amount: '50.00', expires_at: new Date(), delivery_latitude: point.latitude, delivery_longitude: point.longitude });

    await expect(call({ latitude: -17.9, longitude: -63.3 }, 'whatsapp')).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    await expect(call(point, 'whatsapp')).resolves.toMatchObject({ requestId: 'req-1' });
    expect(inserted).toHaveLength(0);
  });

  it('reintento de una solicitud de siempre (sin ubicación) sin ubicación: igual que antes', async () => {
    const { call } = lateService({ id: 'req-1', request_number: 'SOL-000001', subtotal_amount: '50.00', expires_at: new Date() });

    await expect(call(null)).resolves.toMatchObject({ requestId: 'req-1' });
  });

  it('una solicitud de siempre con un reintento que ahora trae ubicación también es un conflicto', async () => {
    const { call } = lateService({ id: 'req-1', request_number: 'SOL-000001', subtotal_amount: '50.00', expires_at: new Date() });

    await expect(call(point)).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });
});
