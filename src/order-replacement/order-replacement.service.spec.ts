import { OrderReplacementService } from './order-replacement.service';
import { ALL_AVAILABLE } from '../operational-settings/availability.fixtures';

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


/** Query builder falso: cualquier método de encadenado se devuelve a sí mismo; los terminales resuelven `result`. */
function chain(result: unknown) {
  const obj: Record<string, jest.Mock> = {};
  for (const method of ['select', 'selectAll', 'where', 'orderBy', 'limit', 'forUpdate', 'set', 'innerJoin']) {
    obj[method] = jest.fn(() => obj);
  }
  obj.execute = jest.fn().mockResolvedValue(Array.isArray(result) ? result : []);
  obj.executeTakeFirst = jest.fn().mockResolvedValue(result);
  obj.executeTakeFirstOrThrow = jest.fn().mockResolvedValue(result);
  return obj;
}

function tableRouter(byTable: Record<string, ReturnType<typeof chain>>) {
  return jest.fn((table: string) => byTable[table] ?? chain(undefined));
}

const customer = { id: 'customer-1' };

function createService(opts: {
  dbSelectFrom: jest.Mock;
  trxSelectFrom?: jest.Mock;
  trxUpdateTable?: jest.Mock;
  orders?: Partial<{
    createOrderInTransaction: jest.Mock;
    applyLocationLocked: jest.Mock;
    findById: jest.Mock;
    notifyOrderCreated: jest.Mock;
  }>;
}) {
  const trx = { selectFrom: opts.trxSelectFrom ?? jest.fn(), updateTable: opts.trxUpdateTable ?? jest.fn(() => chain(undefined)) };
  const db = { selectFrom: opts.dbSelectFrom, transaction: () => ({ execute: async (fn: (t: typeof trx) => unknown) => fn(trx) }) };
  const idempotency = {
    run: jest.fn(async ({ execute }: { execute: (t: typeof trx) => Promise<{ status: number; body: unknown }> }) => {
      const result = await execute(trx);
      return { body: result.body, status: result.status, created: true };
    }),
  };
  const operationalSettings = {
    getRow: jest.fn().mockResolvedValue({ business_opens_hour: 0, business_closes_hour: 23, ...ALL_AVAILABLE }),
  };
  const cashRegister = { isOpen: jest.fn().mockResolvedValue(true) };
  const orders = {
    createOrderInTransaction: jest.fn().mockResolvedValue({ id: 'new-order', orderNumber: 'ORD-NEW' }),
    applyLocationLocked: jest.fn().mockResolvedValue({ decision: 'attach', quote: { result: 'applied' } }),
    findById: jest.fn().mockResolvedValue({ id: 'new-order' }),
    notifyOrderCreated: jest.fn().mockResolvedValue(undefined),
    ...opts.orders,
  };

  const service = new OrderReplacementService(
    db as never,
    idempotency as never,
    operationalSettings as never,
    cashRegister as never,
    orders as never,
  );
  return { service, trx, orders };
}

describe('OrderReplacementService.resolveReplaceable', () => {
  it('returns no_order when the phone has no customer', async () => {
    const { service } = createService({ dbSelectFrom: tableRouter({ customers: chain(undefined) }) });
    await expect(service.resolveReplaceable('+59170001234', 'whatsapp')).resolves.toEqual({ result: 'no_order' });
  });

  it('returns no_order when the customer has no active order', async () => {
    const { service } = createService({
      dbSelectFrom: tableRouter({ customers: chain(customer), orders: chain(undefined) }),
    });
    await expect(service.resolveReplaceable('+59170001234', 'whatsapp')).resolves.toEqual({ result: 'no_order' });
  });

  it('returns not_replaceable when the active order is already paid', async () => {
    const order = { id: 'order-1', order_number: 'ORD-0001', status: 'confirmed', payment_status: 'paid', delivery_type: 'pickup', delivery_latitude: null, delivery_longitude: null, notes: null };
    const ordersChain = chain(order);
    const { service } = createService({
      dbSelectFrom: tableRouter({
        customers: chain(customer),
        orders: ordersChain,
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
    });
    await expect(service.resolveReplaceable('+59170001234', 'whatsapp')).resolves.toEqual({
      result: 'not_replaceable',
      reasonCode: 'already_paid',
    });
    // El "último pedido activo" nunca cruza de canal — un pedido POS del mismo cliente no es candidato.
    expect(ordersChain.where).toHaveBeenCalledWith('channel', '=', 'whatsapp');
  });

  it('returns the cart (ids + quantities, no prices) for a replaceable order', async () => {
    const order = { id: 'order-1', order_number: 'ORD-0001', status: 'awaiting_location', payment_status: 'unpaid', payment_method: 'qr', delivery_type: 'delivery', delivery_latitude: null, delivery_longitude: null, notes: null };
    const items = [{ product_id: 'p1', quantity: 2, excluded_complements: ['cebolla'] }];
    const promotions = [{ promotion_id: 'promo-1', combo_quantity: 1 }];
    const { service } = createService({
      dbSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(order),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
        order_items: chain(items),
        order_promotions: chain(promotions),
      }),
    });

    await expect(service.resolveReplaceable('+59170001234', 'whatsapp')).resolves.toEqual({
      result: 'replaceable',
      orderId: 'order-1',
      orderNumber: 'ORD-0001',
      status: 'awaiting_location',
      deliveryType: 'delivery',
      paymentMethod: 'qr',
      hasLocation: false,
      cart: {
        deliveryType: 'delivery',
        items: [{ productId: 'p1', quantity: 2, excludedComplements: ['cebolla'] }],
        promotions: [{ promotionId: 'promo-1', quantity: 1 }],
      },
    });
  });
});

describe('OrderReplacementService.appendNote', () => {
  const dto = { customerPhone: '+59170001234', note: 'sin cebolla', sourceMessageId: 'wamid-1' };

  it('returns no_order when the phone has no customer', async () => {
    const { service } = createService({ dbSelectFrom: jest.fn(), trxSelectFrom: tableRouter({ customers: chain(undefined) }) });
    await expect(service.appendNote(dto, 'whatsapp-gateway', 'whatsapp')).resolves.toEqual({ result: 'no_order' });
  });

  it('returns not_allowed when the active order already has a money signal', async () => {
    const order = { id: 'order-1', status: 'confirmed', payment_status: 'unpaid', notes: null };
    const ordersChain = chain(order);
    const { service, trx } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: ordersChain,
        bank_qr_charges: chain([{ status: 'paid_unapplied', paid_detected_at: new Date() }]),
        payment_attempts: chain([]),
      }),
    });
    await expect(service.appendNote(dto, 'whatsapp-gateway', 'whatsapp')).resolves.toEqual({
      result: 'not_allowed',
      reasonCode: 'payment_in_progress',
    });
    expect(trx.updateTable).not.toHaveBeenCalled();
    expect(ordersChain.where).toHaveBeenCalledWith('channel', '=', 'whatsapp');
  });

  it('never resolves/writes over a POS order even if it is the customer’s most recent (channel filter in the query itself)', async () => {
    // El mock no simula filtrado real; esto verifica que la query arma el
    // WHERE channel='whatsapp' — la garantía real la da Postgres al filtrar.
    const ordersChain = chain(undefined); // "ninguna fila pasa el filtro" (todo lo del cliente es POS)
    const { service } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({ customers: chain(customer), orders: ordersChain }),
    });
    await expect(service.appendNote(dto, 'whatsapp-gateway', 'whatsapp')).resolves.toEqual({ result: 'no_order' });
    expect(ordersChain.where).toHaveBeenCalledWith('channel', '=', 'whatsapp');
  });

  it('appends to existing notes and saves', async () => {
    const order = { id: 'order-1', status: 'confirmed', payment_status: 'unpaid', notes: 'ya tenía una nota' };
    const updateOrders = chain(undefined);
    const { service, trx } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(order),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
      trxUpdateTable: jest.fn(() => updateOrders),
    });

    await expect(service.appendNote(dto, 'whatsapp-gateway', 'whatsapp')).resolves.toEqual({ result: 'saved' });
    expect(trx.updateTable).toHaveBeenCalledWith('orders');
    expect(updateOrders.set).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'ya tenía una nota\nsin cebolla' }),
    );
  });
});

describe('OrderReplacementService.createReplacement', () => {
  const dto = {
    customerPhone: '+59170001234',
    orderId: 'order-1',
    customerName: 'Juan Pérez',
    deliveryType: 'delivery' as const,
    paymentMethod: 'qr' as const,
    items: [{ productId: 'p1', quantity: 2 }],
    promotions: [],
  };

  it('never looks up dto.orderId directly — resolves the latest active WhatsApp order independently and compares', async () => {
    // El pedido activo REAL del cliente es "order-2" (más nuevo); el agente
    // manda un orderId viejo ("order-1", lo que le dio un GET anterior).
    const currentOrder = { id: 'order-2', customer_id: 'customer-1', status: 'confirmed', payment_status: 'unpaid', delivery_type: 'delivery', delivery_latitude: null, delivery_longitude: null };
    const { service, orders } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(currentOrder),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
    });

    const result = await service.createReplacement(dto, 'idem-1', 'whatsapp-gateway', 'whatsapp');
    expect(result).toEqual({ httpStatus: 409, body: { result: 'stale_order', currentOrderId: 'order-2' } });
    expect(orders.createOrderInTransaction).not.toHaveBeenCalled();
  });

  it('never treats a POS order (same customer, more recent) as the replacement target', async () => {
    // findActiveOrder filtra channel='whatsapp' en la query; acá simulamos
    // que "lo único activo" que la query devuelve YA es whatsapp (el POS
    // quedó afuera del WHERE) — el orderId del dto sigue siendo el correcto.
    const currentOrder = { id: 'order-1', customer_id: 'customer-1', status: 'confirmed', payment_status: 'unpaid', delivery_type: 'delivery', delivery_latitude: null, delivery_longitude: null };
    const ordersChain = chain(currentOrder);
    const { service } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: ordersChain,
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
    });

    await service.createReplacement(dto, 'idem-1', 'whatsapp-gateway', 'whatsapp');
    expect(ordersChain.where).toHaveBeenCalledWith('channel', '=', 'whatsapp');
  });

  it('rejects when the order already has a money signal, without cancelling it', async () => {
    const oldOrder = { id: 'order-1', customer_id: 'customer-1', status: 'confirmed', payment_status: 'paid', delivery_type: 'delivery', delivery_latitude: null, delivery_longitude: null };
    const { service, trx, orders } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(oldOrder),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
    });

    const result = await service.createReplacement(dto, 'idem-1', 'whatsapp-gateway', 'whatsapp');
    expect(result).toEqual({ httpStatus: 409, body: { result: 'not_replaceable', reasonCode: 'already_paid' } });
    expect(trx.updateTable).not.toHaveBeenCalled();
    expect(orders.createOrderInTransaction).not.toHaveBeenCalled();
  });

  it('rejects a rejected/pending_review payment_status too, not just paid', async () => {
    const oldOrder = { id: 'order-1', customer_id: 'customer-1', status: 'confirmed', payment_status: 'rejected', delivery_type: 'delivery', delivery_latitude: null, delivery_longitude: null };
    const { service } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(oldOrder),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
    });

    const result = await service.createReplacement(dto, 'idem-1', 'whatsapp-gateway', 'whatsapp');
    expect(result).toEqual({
      httpStatus: 409,
      body: { result: 'not_replaceable', reasonCode: 'payment_status_not_unpaid' },
    });
  });

  it('cancels the old order, creates the new one, links both, reuses location, and notifies after commit', async () => {
    const oldOrder = {
      id: 'order-1',
      customer_id: 'customer-1',
      status: 'confirmed',
      payment_status: 'unpaid',
      delivery_type: 'delivery',
      delivery_latitude: -17.78,
      delivery_longitude: -63.18,
    };
    const updateOrders = chain(undefined);
    const { service, trx, orders } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(oldOrder), // reused for the FOR UPDATE lookup AND the post-create re-select of the new row
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
      trxUpdateTable: jest.fn(() => updateOrders),
    });

    const result = await service.createReplacement(dto, 'idem-1', 'whatsapp-gateway', 'whatsapp');

    expect(result.httpStatus).toBe(201);
    expect(result.body).toEqual({
      result: 'replaced',
      orderId: 'new-order',
      orderNumber: 'ORD-NEW',
      replacedOrderId: 'order-1',
    });

    // Vieja cancelada
    expect(updateOrders.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled', status_updated_by: 'system:replacement' }),
    );
    // Nueva creada reusando la MISMA lógica autoritativa que POST /orders
    expect(orders.createOrderInTransaction).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({ customerId: 'customer-1', channel: 'whatsapp', deliveryType: 'delivery' }),
    );
    // Vinculadas en ambos sentidos
    expect(updateOrders.set).toHaveBeenCalledWith(
      expect.objectContaining({ replaces_order_id: 'order-1' }),
    );
    expect(updateOrders.set).toHaveBeenCalledWith(
      expect.objectContaining({ replaced_by_order_id: 'new-order' }),
    );
    // Ubicación reusada (recotizada, nunca copiado el monto)
    expect(orders.applyLocationLocked).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({ id: 'order-1' }),
      { latitude: -17.78, longitude: -63.18 },
    );
    // La notificación es post-commit (fuera de la transacción), best-effort
    await Promise.resolve();
    expect(orders.findById).toHaveBeenCalledWith('new-order');
    expect(orders.notifyOrderCreated).toHaveBeenCalled();
  });

  it('reports stale_order (not not_found) when a concurrent replacement committed between the locked check and now', async () => {
    // Contra Postgres real: el SELECT ... FOR UPDATE de la transacción
    // perdedora se bloquea en la fila vieja; cuando la ganadora comitea
    // (fila ahora 'cancelled'), Postgres re-evalúa SOLO esa fila puntual
    // (EvalPlanQual) y la descarta — sin volver a escanear la tabla, así que
    // el primer SELECT nunca ve el pedido nuevo recién creado. Acá se
    // simula exactamente eso: el primer executeTakeFirst (locked) no
    // encuentra nada, el segundo (sin lock, nuevo snapshot en READ
    // COMMITTED) sí encuentra el pedido que el ganador acaba de crear.
    const newActiveOrder = { id: 'order-9', customer_id: 'customer-1', status: 'confirmed', payment_status: 'unpaid', delivery_type: 'delivery', delivery_latitude: null, delivery_longitude: null };
    const ordersChain = chain(undefined);
    ordersChain.executeTakeFirst = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(newActiveOrder);
    const { service, orders } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({ customers: chain(customer), orders: ordersChain }),
    });

    const result = await service.createReplacement(dto, 'idem-1', 'whatsapp-gateway', 'whatsapp');
    expect(result).toEqual({ httpStatus: 409, body: { result: 'stale_order', currentOrderId: 'order-9' } });
    expect(orders.createOrderInTransaction).not.toHaveBeenCalled();
  });

  it('does not reuse location when switching delivery -> pickup', async () => {
    const oldOrder = {
      id: 'order-1',
      customer_id: 'customer-1',
      status: 'confirmed',
      payment_status: 'unpaid',
      delivery_type: 'delivery',
      delivery_latitude: -17.78,
      delivery_longitude: -63.18,
    };
    const { service, orders } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(oldOrder),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
    });

    await service.createReplacement({ ...dto, deliveryType: 'pickup' }, 'idem-1', 'whatsapp-gateway', 'whatsapp');
    expect(orders.applyLocationLocked).not.toHaveBeenCalled();
  });
});

describe('OrderReplacementService — canal web (apiClient=web)', () => {
  const dto = {
    customerPhone: '+59170001234',
    orderId: 'order-1',
    customerName: 'Juan Pérez',
    deliveryType: 'delivery' as const,
    paymentMethod: 'qr' as const,
    items: [{ productId: 'p1', quantity: 2 }],
    promotions: [],
  };

  it('resuelve/reemplaza el pedido activo filtrando por channel=web, nunca whatsapp', async () => {
    const oldOrder = { id: 'order-1', customer_id: 'customer-1', status: 'confirmed', payment_status: 'unpaid', delivery_type: 'delivery', delivery_latitude: null, delivery_longitude: null };
    const ordersChain = chain(oldOrder);
    const { service } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: ordersChain,
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
    });

    await service.createReplacement(dto, 'idem-1', 'web', 'web');
    expect(ordersChain.where).toHaveBeenCalledWith('channel', '=', 'web');
    expect(ordersChain.where).not.toHaveBeenCalledWith('channel', '=', 'whatsapp');
  });

  it('un pedido activo de WHATSAPP es invisible para una llamada web: nunca lo cruza (not_found, no stale_order)', async () => {
    // El mock no filtra de verdad; esto representa lo que Postgres devuelve
    // cuando el único pedido activo del cliente es de otro canal: la query
    // con channel='web' no encuentra nada, así que no hay candidato alguno.
    const { service, orders } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({ customers: chain(customer), orders: chain(undefined) }),
    });

    const result = await service.createReplacement(dto, 'idem-1', 'web', 'web');
    expect(result).toEqual({ httpStatus: 404, body: { result: 'not_found' } });
    expect(orders.createOrderInTransaction).not.toHaveBeenCalled();
  });

  it('el pedido nuevo nace con channel=web, no whatsapp, y la respuesta incluye orderNumber', async () => {
    const oldOrder = { id: 'order-1', customer_id: 'customer-1', status: 'confirmed', payment_status: 'unpaid', delivery_type: 'pickup', delivery_latitude: null, delivery_longitude: null };
    const updateOrders = chain(undefined);
    const { service, trx, orders } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(oldOrder),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
      trxUpdateTable: jest.fn(() => updateOrders),
    });

    const result = await service.createReplacement({ ...dto, deliveryType: 'pickup' }, 'idem-1', 'web', 'web');

    expect(result.body).toEqual({
      result: 'replaced',
      orderId: 'new-order',
      orderNumber: 'ORD-NEW',
      replacedOrderId: 'order-1',
    });
    expect(orders.createOrderInTransaction).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({ channel: 'web' }),
    );
  });

  it('no copia la ubicación del pedido viejo (evita location_conflict cuando el checkout web adjunta la suya después)', async () => {
    const oldOrder = {
      id: 'order-1',
      customer_id: 'customer-1',
      status: 'confirmed',
      payment_status: 'unpaid',
      delivery_type: 'delivery',
      delivery_latitude: -17.78,
      delivery_longitude: -63.18,
    };
    const { service, orders } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(oldOrder),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
    });

    await service.createReplacement(dto, 'idem-1', 'web', 'web');
    // A diferencia de WhatsApp (ver test "reuses location" arriba), acá
    // nunca se llama — el pedido nuevo queda awaiting_location para que el
    // checkout adjunte él mismo la ubicación que el cliente elija.
    expect(orders.applyLocationLocked).not.toHaveBeenCalled();
  });

  it('acepta paymentMethod distinto de qr (web no está restringido a QR como WhatsApp)', async () => {
    const oldOrder = { id: 'order-1', customer_id: 'customer-1', status: 'confirmed', payment_status: 'unpaid', delivery_type: 'pickup', delivery_latitude: null, delivery_longitude: null };
    const { service } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(oldOrder),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
    });

    const result = await service.createReplacement(
      { ...dto, deliveryType: 'pickup', paymentMethod: 'cash' },
      'idem-1',
      'web',
      'web',
    );
    expect(result.httpStatus).toBe(201);
  });
});

describe('OrderReplacementService — ubicación del checkout web al reemplazar (NO ejecutado todavía)', () => {
  const point = { latitude: -17.7833, longitude: -63.1821 };
  const oldPoint = { latitude: -17.9, longitude: -63.3 };
  const dto = {
    customerPhone: '+59170001234',
    orderId: 'order-1',
    customerName: 'Juan Pérez',
    deliveryType: 'delivery' as const,
    paymentMethod: 'cash' as const,
    items: [{ productId: 'p1', quantity: 2 }],
    promotions: [],
  };
  const oldOrder = {
    id: 'order-1',
    customer_id: 'customer-1',
    status: 'confirmed',
    payment_status: 'unpaid',
    delivery_type: 'delivery',
    delivery_latitude: oldPoint.latitude,
    delivery_longitude: oldPoint.longitude,
  };
  const tables = () =>
    tableRouter({ customers: chain(customer), orders: chain(oldOrder), bank_qr_charges: chain([]), payment_attempts: chain([]) });

  it('web con ubicación: el pedido nuevo nace con ESTA ubicación (la que eligió ahora), no con la del pedido viejo', async () => {
    const { service, orders } = createService({ dbSelectFrom: jest.fn(), trxSelectFrom: tables() });

    const result = await service.createReplacement({ ...dto, deliveryLocation: point }, 'idem-1', 'web', 'web');

    expect(result.httpStatus).toBe(201);
    expect(orders.createOrderInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channel: 'web', deliveryLocation: point }),
    );
    // La ubicación se aplica DENTRO de createOrderInTransaction; el reuso de WhatsApp (applyLocationLocked) sigue sin tocarse en web.
    expect(orders.applyLocationLocked).not.toHaveBeenCalled();
  });

  it('web con ubicación: tras el commit avisa con locationProvided=true (sin location_request)', async () => {
    const { service, orders } = createService({ dbSelectFrom: jest.fn(), trxSelectFrom: tables() });

    await service.createReplacement({ ...dto, deliveryLocation: point }, 'idem-1', 'web', 'web');
    await new Promise((resolve) => setImmediate(resolve));

    expect(orders.notifyOrderCreated).toHaveBeenCalledWith(expect.anything(), { locationProvided: true });
  });

  it('web SIN ubicación: igual que antes (deliveryLocation=null, queda esperando ubicación, locationProvided=false)', async () => {
    const { service, orders } = createService({ dbSelectFrom: jest.fn(), trxSelectFrom: tables() });

    await service.createReplacement(dto, 'idem-1', 'web', 'web');
    await new Promise((resolve) => setImmediate(resolve));

    expect(orders.createOrderInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deliveryLocation: null }));
    expect(orders.notifyOrderCreated).toHaveBeenCalledWith(expect.anything(), { locationProvided: false });
    expect(orders.applyLocationLocked).not.toHaveBeenCalled();
  });

  it('WhatsApp no puede mandarla: se rechaza antes de cancelar nada ni crear el pedido, y su reuso de ubicación no cambia', async () => {
    const { service, orders } = createService({ dbSelectFrom: jest.fn(), trxSelectFrom: tables() });

    await expect(service.createReplacement({ ...dto, deliveryLocation: point }, 'idem-1', 'whatsapp-gateway', 'whatsapp')).rejects.toMatchObject({
      code: 'delivery_location_not_supported',
    });
    expect(orders.createOrderInTransaction).not.toHaveBeenCalled();
  });

  it('pickup con ubicación se rechaza antes de tocar nada', async () => {
    const { service, orders } = createService({ dbSelectFrom: jest.fn(), trxSelectFrom: tables() });

    await expect(service.createReplacement({ ...dto, deliveryType: 'pickup', deliveryLocation: point }, 'idem-1', 'web', 'web')).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(orders.createOrderInTransaction).not.toHaveBeenCalled();
  });

  it('si el pedido nuevo no se puede crear o cotizar, el error se propaga (la transacción revierte la cancelación del viejo) y no se vincula nada', async () => {
    const trxUpdateTable = jest.fn(() => chain(undefined));
    const { service } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tables(),
      trxUpdateTable,
      orders: { createOrderInTransaction: jest.fn().mockRejectedValue(new Error('cotización fallida')) },
    });

    await expect(service.createReplacement({ ...dto, deliveryLocation: point }, 'idem-1', 'web', 'web')).rejects.toThrow('cotización fallida');
    // Solo la cancelación del viejo (que la transacción deshace); jamás los vínculos replaces_order_id / replaced_by_order_id.
    expect(trxUpdateTable).toHaveBeenCalledTimes(1);
  });
});
