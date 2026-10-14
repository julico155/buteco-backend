import { Logger } from '@nestjs/common';
import { DeliveryNoticesService } from './delivery-notices.service';

const eligibleOrder = {
  id: 'order-1',
  order_number: 'ORD-0007',
  customer_name: 'Juan Pérez',
  customer_phone: '59170000000',
  delivery_type: 'delivery',
  payment_method: 'qr',
  payment_status: 'paid',
  notes: 'Sin cebolla',
  delivery_quote_status: 'quoted',
  delivery_base_amount: '10',
  delivery_surcharge_amount: '3',
  subtotal_amount: '42',
  total_amount: '55',
  delivery_fee_paid: false,
  latitude: -17.78,
  longitude: -63.18,
  distance_meters: 4800,
};

function createService(order: Record<string, unknown> | undefined = eligibleOrder, notify = jest.fn()) {
  const ordersQuery = {
    leftJoin: jest.fn(),
    select: jest.fn(),
    where: jest.fn(),
    executeTakeFirst: jest.fn().mockResolvedValue(order),
  };
  ordersQuery.leftJoin.mockReturnValue(ordersQuery);
  ordersQuery.select.mockReturnValue(ordersQuery);
  ordersQuery.where.mockReturnValue(ordersQuery);

  const itemQuery = {
    select: jest.fn(),
    where: jest.fn(),
    execute: jest.fn().mockResolvedValue([{ product_name_snapshot: 'Pizza', quantity: 1 }]),
  };
  itemQuery.select.mockReturnValue(itemQuery);
  itemQuery.where.mockReturnValue(itemQuery);

  const promotionQuery = {
    select: jest.fn(),
    where: jest.fn(),
    execute: jest.fn().mockResolvedValue([
      {
        combo_quantity: 1,
        components_snapshot: [
          { name: 'Pizza', quantity: 2 },
          { name: 'Hamburguesa', quantity: 1 },
        ],
      },
    ]),
  };
  promotionQuery.select.mockReturnValue(promotionQuery);
  promotionQuery.where.mockReturnValue(promotionQuery);

  const db = {
    selectFrom: jest.fn((table: string) => {
      if (table === 'orders') return ordersQuery;
      if (table === 'order_items') return itemQuery;
      if (table === 'order_promotions') return promotionQuery;
      throw new Error(`unexpected table ${table}`);
    }),
  };
  return {
    service: new DeliveryNoticesService(
      db as never,
      { notifyNow: notify } as never,
      { get: () => 'delivery-group' } as never,
    ),
    notify,
  };
}

describe('DeliveryNoticesService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends one delivery_notice with merged product and promotion components', async () => {
    const notify = jest.fn().mockResolvedValue(undefined);
    const { service } = createService(eligibleOrder, notify);

    await service.notifyConfirmed('order-1');

    expect(notify).toHaveBeenCalledWith({
      channel: 'telegram',
      kind: 'delivery_notice',
      targetRef: 'order-1',
      payload: expect.objectContaining({
        chatRef: 'delivery-group',
        text: expect.stringContaining('  3x Pizza'),
      }),
    });
    expect(notify.mock.calls[0][0].payload.text).toContain('  1x Hamburguesa');
  });

  it.each([
    ['pickup', { ...eligibleOrder, delivery_type: 'pickup' }],
    ['unquoted delivery', { ...eligibleOrder, delivery_quote_status: 'pending' }],
    ['unpaid QR delivery (no excepción para QR)', { ...eligibleOrder, payment_status: 'unpaid' }],
    ['delivery without GPS', { ...eligibleOrder, latitude: null }],
  ])('does not notify a %s order', async (_label, order) => {
    const notify = jest.fn();
    const { service } = createService(order, notify);

    await service.notifyConfirmed('order-1');

    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies a cash delivery order already quoted, even though it is still unpaid', async () => {
    const notify = jest.fn().mockResolvedValue(undefined);
    const cashOrder = { ...eligibleOrder, payment_method: 'cash', payment_status: 'unpaid' };
    const { service } = createService(cashOrder, notify);

    await service.notifyConfirmed('order-1');

    expect(notify).toHaveBeenCalledTimes(1);
    const text = notify.mock.calls[0][0].payload.text as string;
    expect(text).toContain('PEDIDO EN EFECTIVO');
    expect(text).toContain('TOTAL A COBRAR');
  });

  it('does not notify a cash delivery order that is not quoted yet', async () => {
    const notify = jest.fn();
    const cashOrder = { ...eligibleOrder, payment_method: 'cash', payment_status: 'unpaid', delivery_quote_status: 'pending' };
    const { service } = createService(cashOrder, notify);

    await service.notifyConfirmed('order-1');

    expect(notify).not.toHaveBeenCalled();
  });

  it('does not log PII when the Telegram delivery job fails', async () => {
    const notify = jest.fn().mockRejectedValue(new Error('gateway body phone=59170000000'));
    const { service } = createService(eligibleOrder, notify);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await expect(service.notifyConfirmed('order-1')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('delivery_notice_failed orderId=order-1');
    expect(String(warn.mock.calls[0][0])).not.toContain('59170000000');
  });
});
