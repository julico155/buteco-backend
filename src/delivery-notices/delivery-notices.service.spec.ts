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

function createService(
  order: Record<string, unknown> | undefined = eligibleOrder,
  notify = jest.fn(),
  extra: { items?: Record<string, unknown>[]; productRows?: Record<string, unknown>[] } = {},
) {
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
    execute: jest.fn().mockResolvedValue(
      extra.items ?? [
        { product_id: 'prod-pizza', product_name_snapshot: 'Pizza', quantity: 1, selected_options: [] },
      ],
    ),
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
          { productId: 'prod-pizza', name: 'Pizza', quantity: 2 },
          { productId: 'prod-hamburguesa', name: 'Hamburguesa', quantity: 1 },
        ],
      },
    ]),
  };
  promotionQuery.select.mockReturnValue(promotionQuery);
  promotionQuery.where.mockReturnValue(promotionQuery);

  const productQuery = { select: jest.fn(), where: jest.fn(), execute: jest.fn().mockResolvedValue(extra.productRows ?? []) };
  productQuery.select.mockReturnValue(productQuery);
  productQuery.where.mockReturnValue(productQuery);

  const db = {
    selectFrom: jest.fn((table: string) => {
      if (table === 'products') return productQuery;
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
        text: expect.stringContaining('  3 x Pizza'),
      }),
    });
    expect(notify.mock.calls[0][0].payload.text).toContain('  1 x Hamburguesa');
  });

  it('names each line with its people and ends with the longest preparation time', async () => {
    const notify = jest.fn().mockResolvedValue(undefined);
    const { service } = createService(eligibleOrder, notify, {
      items: [
        {
          product_id: 'prod-zeus',
          product_name_snapshot: 'Tabla de Zeus',
          quantity: 1,
          selected_options: [{ optionName: 'Pollo', showInNotice: false }],
        },
        {
          product_id: 'prod-zeus',
          product_name_snapshot: 'Tabla de Zeus',
          quantity: 1,
          selected_options: [{ optionName: 'Costilla de res', showInNotice: false }],
        },
        {
          product_id: 'prod-tablita',
          product_name_snapshot: 'Tablita de pollo',
          quantity: 1,
          selected_options: [{ optionName: '1 persona', showInNotice: true }],
        },
      ],
      // Personas y minutos salen del catálogo vivo. El combo de eligibleOrder trae Pizza y Hamburguesa: la Hamburguesa tarda 15.
      productRows: [
        { id: 'prod-zeus', serves_label: '2 a 3 personas', prep_minutes: 40 },
        { id: 'prod-tablita', serves_label: null, prep_minutes: 25 },
        { id: 'prod-hamburguesa', serves_label: null, prep_minutes: 15 },
        { id: 'prod-pizza', serves_label: null, prep_minutes: null },
      ],
    });

    await service.notifyConfirmed('order-1');

    const text = notify.mock.calls[0][0].payload.text as string;
    expect(text).toContain('  2 x Tabla de Zeus (2 a 3 personas)');
    expect(text).toContain('  1 x Tablita de pollo (1 persona)');
    // Las carnes elegidas no se nombran en el aviso.
    expect(text).not.toContain('Pollo');
    expect(text).not.toContain('Costilla');
    expect(text.split('\n').at(-1)).toBe('Tiempo de preparación: ~40 min');
  });

  it('prints no preparation line when no product declares a time', async () => {
    const notify = jest.fn().mockResolvedValue(undefined);
    const { service } = createService(eligibleOrder, notify);

    await service.notifyConfirmed('order-1');

    expect(notify.mock.calls[0][0].payload.text).not.toContain('Tiempo de preparación');
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
