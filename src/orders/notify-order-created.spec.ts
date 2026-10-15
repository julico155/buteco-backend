import { OrderResponse, OrdersService } from './orders.service';

const baseOrder: OrderResponse = {
  id: 'order-1',
  orderNumber: 'ORD-260929-007',
  customerId: 'customer-1',
  channel: 'whatsapp',
  customerName: 'Juan Pérez',
  deliveryType: 'delivery',
  tableId: null,
  billRequestedAt: null,
  paymentMethod: 'qr',
  qrScope: null,
  paymentStatus: 'unpaid',
  status: 'awaiting_location',
  notes: null,
  subtotalAmount: 42,
  deliveryBaseAmount: 0,
  deliverySurchargeAmount: 0,
  totalAmount: 42,
  deliveryQuoteStatus: 'pending',
  deliveryDistanceMeters: null,
  cashConfirmedAt: null,
  splitCashAmount: null,
  splitQrAmount: null,
  splitCashConfirmedAt: null,
  statusUpdatedBy: null,
  deliveryDriverName: null,
  deliveryAcceptedAt: null,
  deliveredAt: null,
  createdAt: '2026-09-29T00:00:00.000Z',
  updatedAt: '2026-09-29T00:00:00.000Z',
  items: [],
  promotions: [],
};

function createService(overrides: { qrPayments?: unknown; db?: unknown } = {}) {
  const notifications = { notifyNow: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: jest.fn((key: string) =>
      key === 'unpaidOrderTtlMinutes' ? 20 : key === 'posQrMode' ? 'bank' : undefined,
    ),
  };
  const service = new OrdersService(
    (overrides.db ?? {}) as never,
    {} as never,
    {} as never,
    {} as never,
    notifications as never,
    {} as never,
    (overrides.qrPayments ?? {}) as never,
    config as never,
    {} as never,
    { resolve: jest.fn().mockResolvedValue(null) } as never, // PaymentOptionsService,
  );
  return { service, notifications, config };
}

/** notifyOrderCreated es privado: se llama tal cual lo hace create() tras el commit. */
async function notifyOrderCreated(service: OrdersService, order: OrderResponse): Promise<void> {
  await (service as unknown as { notifyOrderCreated(order: OrderResponse): Promise<void> }).notifyOrderCreated(
    order,
  );
}

describe('OrdersService.notifyOrderCreated', () => {
  it('sends a single location_request (with orderNumber) for a delivery order, never order_received', async () => {
    const { service, notifications } = createService();

    await notifyOrderCreated(service, { ...baseOrder, status: 'awaiting_location' });

    expect(notifications.notifyNow).toHaveBeenCalledTimes(1);
    expect(notifications.notifyNow).toHaveBeenCalledWith({
      channel: 'whatsapp',
      kind: 'location_request',
      targetRef: 'order-1',
      payload: { customerId: 'customer-1', reason: 'delivery_location', orderNumber: 'ORD-260929-007' },
    });
    expect(notifications.notifyNow).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'order_received' }),
    );
  });

  it('keeps order_received for pickup (confirmed at creation, no QR since paymentMethod is cash)', async () => {
    const { service, notifications } = createService();

    await notifyOrderCreated(service, {
      ...baseOrder,
      status: 'confirmed',
      deliveryType: 'pickup',
      paymentMethod: 'cash',
    });

    expect(notifications.notifyNow).toHaveBeenCalledWith({
      channel: 'whatsapp',
      kind: 'order_received',
      targetRef: 'order-1',
      payload: {
        customerId: 'customer-1',
        messageType: 'order_received',
        context: { orderNumber: 'ORD-260929-007', deliveryType: 'pickup' },
      },
    });
    expect(notifications.notifyNow).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'location_request' }),
    );
  });

  it('sends cash_on_delivery_confirmation with the full total (comida + envío) for a cash pickup order', async () => {
    const { service, notifications } = createService();

    await notifyOrderCreated(service, {
      ...baseOrder,
      status: 'confirmed',
      deliveryType: 'pickup',
      paymentMethod: 'cash',
      totalAmount: 42,
    });

    expect(notifications.notifyNow).toHaveBeenCalledWith({
      channel: 'whatsapp',
      kind: 'cash_on_delivery_confirmation',
      targetRef: 'order-1',
      payload: {
        customerId: 'customer-1',
        messageType: 'cash_on_delivery_confirmation',
        context: {
          orderNumber: 'ORD-260929-007',
          deliveryType: 'pickup',
          subtotalAmount: 42,
          deliveryBaseAmount: 0,
          deliverySurchargeAmount: 0,
          deliveryAmount: 0,
          totalAmount: 42,
        },
      },
    });
    // Nunca genera/manda un QR para un pedido en efectivo.
    expect(notifications.notifyNow).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'qr_confirmation' }),
    );
  });

  it('sends the full delivery breakdown (subtotal, envío, recargo) for a cash delivery order', async () => {
    const { service, notifications } = createService();

    await notifyOrderCreated(service, {
      ...baseOrder,
      status: 'confirmed',
      deliveryType: 'delivery',
      paymentMethod: 'cash',
      subtotalAmount: 42,
      deliveryBaseAmount: 10,
      deliverySurchargeAmount: 3,
      totalAmount: 55,
    });

    expect(notifications.notifyNow).toHaveBeenCalledWith({
      channel: 'whatsapp',
      kind: 'cash_on_delivery_confirmation',
      targetRef: 'order-1',
      payload: {
        customerId: 'customer-1',
        messageType: 'cash_on_delivery_confirmation',
        context: {
          orderNumber: 'ORD-260929-007',
          deliveryType: 'delivery',
          subtotalAmount: 42,
          deliveryBaseAmount: 10,
          deliverySurchargeAmount: 3,
          deliveryAmount: 13,
          totalAmount: 55,
        },
      },
    });
  });

  it('a failed gateway on location_request does not throw (best-effort)', async () => {
    const { service, notifications } = createService();
    notifications.notifyNow.mockRejectedValueOnce(new Error('gateway down'));

    await expect(
      notifyOrderCreated(service, { ...baseOrder, status: 'awaiting_location' }),
    ).resolves.toBeUndefined();
  });
});

describe('OrdersService — QR del banco caído', () => {
  const qrOrder: OrderResponse = {
    ...baseOrder,
    status: 'confirmed',
    deliveryType: 'pickup',
    paymentMethod: 'qr',
  };

  it('QR generado: manda qr_confirmation con la imagen', async () => {
    const qrPayments = { generateForOrder: jest.fn().mockResolvedValue({ qrImageUrl: 'https://qr.test/1.png' }) };
    const { service, notifications } = createService({ qrPayments });

    await notifyOrderCreated(service, qrOrder);

    expect(notifications.notifyNow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'qr_confirmation' }),
    );
  });

  it('banco caído: avisa qr_unavailable, nunca pide captura ni manda qr_confirmation', async () => {
    const qrPayments = { generateForOrder: jest.fn().mockRejectedValue(new Error('bank down')) };
    const { service, notifications } = createService({ qrPayments });

    await notifyOrderCreated(service, qrOrder);

    expect(notifications.notifyNow).toHaveBeenCalledWith({
      channel: 'whatsapp',
      kind: 'qr_unavailable',
      targetRef: 'order-1',
      payload: {
        customerId: 'customer-1',
        messageType: 'qr_unavailable',
        context: { orderNumber: 'ORD-260929-007', qrAmount: 42, expiresInMinutes: 20 },
      },
    });
    expect(notifications.notifyNow).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'qr_confirmation' }),
    );
    expect(JSON.stringify(notifications.notifyNow.mock.calls)).not.toContain('payment_proof');
  });
});

describe('OrdersService.retryPendingQrCharges', () => {
  function createRetryService(candidates: { id: string }[]) {
    const wheres: unknown[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: Record<string, any> = {
      select: jest.fn(() => chain),
      where: jest.fn((...args: unknown[]) => {
        wheres.push(args);
        return chain;
      }),
      orderBy: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      execute: jest.fn(async () => candidates),
    };
    const db = { selectFrom: jest.fn(() => chain) };
    const { service } = createService({ db });
    const internals = service as unknown as {
      sendQrConfirmation: (order: OrderResponse) => Promise<void>;
    };
    const send = jest.spyOn(internals, 'sendQrConfirmation').mockResolvedValue(undefined);
    jest.spyOn(service, 'findById').mockImplementation(async (id: string) => ({ ...baseOrder, id }));
    return { service, send, wheres };
  }

  it('reintenta cada pedido candidato y devuelve cuántos', async () => {
    const { service, send } = createRetryService([{ id: 'a' }, { id: 'b' }]);

    const attempted = await service.retryPendingQrCharges({ ttlMinutes: 20 });

    expect(attempted).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('un fallo en un pedido no frena a los demás', async () => {
    const { service, send } = createRetryService([{ id: 'a' }, { id: 'b' }]);
    send.mockRejectedValueOnce(new Error('boom'));

    await expect(service.retryPendingQrCharges({ ttlMinutes: 20 })).resolves.toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('solo mira pedidos QR impagos y confirmados de WhatsApp/web, dentro de la ventana del TTL', async () => {
    const { service, wheres } = createRetryService([]);

    await service.retryPendingQrCharges({ ttlMinutes: 20, minAgeSeconds: 60 });

    expect(wheres).toContainEqual(['payment_method', '=', 'qr']);
    expect(wheres).toContainEqual(['payment_status', '=', 'unpaid']);
    expect(wheres).toContainEqual(['status', '=', 'confirmed']);
    expect(wheres).toContainEqual(['channel', 'in', ['whatsapp', 'web']]);
    const lower = wheres.find((w) => w[0] === 'created_at' && w[1] === '>');
    const upper = wheres.find((w) => w[0] === 'created_at' && w[1] === '<');
    const ttlWindow = (upper![2] as Date).getTime() - (lower![2] as Date).getTime();
    expect(ttlWindow).toBe((20 * 60 - 60) * 1000);
  });
});
