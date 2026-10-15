import { OrdersService } from './orders.service';

const cashDelivery = {
  id: 'order-1',
  order_number: 'ORD-0007',
  customer_id: 'customer-1',
  channel: 'whatsapp',
  customer_name: 'Juan Pérez',
  delivery_type: 'delivery',
  payment_method: 'cash',
  payment_status: 'unpaid',
  notes: null,
  status: 'confirmed',
  subtotal_amount: '42',
  delivery_base_amount: '10',
  delivery_surcharge_amount: '3',
  total_amount: '55',
  delivery_quote_status: 'quoted',
  delivery_distance_meters: 4800,
  cash_confirmed_at: null,
  split_cash_amount: null,
  split_qr_amount: null,
  split_cash_confirmed_at: null,
  status_updated_by: null,
  delivery_driver_name: null,
  delivery_accepted_at: null,
  delivered_at: null,
  created_at: new Date('2026-09-29T00:00:00.000Z'),
  updated_at: new Date('2026-09-29T00:00:00.000Z'),
  register_session_id: null,
};

function createService() {
  const lockedOrder = {
    selectAll: jest.fn(),
    where: jest.fn(),
    forUpdate: jest.fn(),
    executeTakeFirst: jest.fn().mockResolvedValue(cashDelivery),
  };
  lockedOrder.selectAll.mockReturnValue(lockedOrder);
  lockedOrder.where.mockReturnValue(lockedOrder);
  lockedOrder.forUpdate.mockReturnValue(lockedOrder);

  const updateOrder = { set: jest.fn(), where: jest.fn(), returningAll: jest.fn() };
  updateOrder.set.mockReturnValue(updateOrder);
  updateOrder.where.mockReturnValue(updateOrder);
  updateOrder.returningAll.mockReturnValue({
    executeTakeFirstOrThrow: jest.fn().mockResolvedValue({
      ...cashDelivery,
      payment_status: 'paid',
      cash_confirmed_at: new Date('2026-09-29T00:01:00.000Z'),
      register_session_id: 'register-1',
    }),
  });

  const trx = {
    selectFrom: jest.fn().mockReturnValue(lockedOrder),
    updateTable: jest.fn().mockReturnValue(updateOrder),
  };

  const items = { selectAll: jest.fn(), where: jest.fn(), orderBy: jest.fn(), execute: jest.fn().mockResolvedValue([]) };
  items.selectAll.mockReturnValue(items);
  items.where.mockReturnValue(items);
  items.orderBy.mockReturnValue(items);
  const promotions = { selectAll: jest.fn(), where: jest.fn(), orderBy: jest.fn(), execute: jest.fn().mockResolvedValue([]) };
  promotions.selectAll.mockReturnValue(promotions);
  promotions.where.mockReturnValue(promotions);
  promotions.orderBy.mockReturnValue(promotions);
  const db = {
    transaction: () => ({ execute: async (fn: (value: typeof trx) => unknown) => fn(trx) }),
    selectFrom: jest.fn((table: string) => (table === 'order_items' ? items : promotions)),
  };
  const notifications = { notifyNow: jest.fn().mockResolvedValue(undefined) };
  const service = new OrdersService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    notifications as never,
    { sessionIdForPayment: jest.fn().mockResolvedValue('register-1') } as never,
    {} as never,
    {} as never,
    {} as never,
    { resolve: jest.fn().mockResolvedValue(null) } as never, // PaymentOptionsService,
  );
  return { service, notifications, updateOrder };
}

describe('OrdersService confirmCash delivery separation', () => {
  it('keeps staff cash confirmation separate from delivery_notice', async () => {
    const { service, notifications, updateOrder } = createService();

    const result = await service.confirmCash('order-1');

    expect(result.paymentStatus).toBe('paid');
    expect(updateOrder.set).toHaveBeenCalledWith(
      expect.objectContaining({ register_session_id: 'register-1', payment_status: 'paid' }),
    );
    expect(notifications.notifyNow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cash_confirmed_customer_notice' }),
    );
    expect(notifications.notifyNow).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'delivery_notice' }),
    );
  });
});
