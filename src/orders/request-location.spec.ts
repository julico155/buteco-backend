import { OrdersService } from './orders.service';

function createService(order: {
  id: string;
  delivery_type: string;
  customer_id: string | null;
  order_number: string;
} | null) {
  const select = {
    select: jest.fn(),
    where: jest.fn(),
    executeTakeFirst: jest.fn().mockResolvedValue(order ?? undefined),
  };
  select.select.mockReturnValue(select);
  select.where.mockReturnValue(select);
  const db = { selectFrom: jest.fn().mockReturnValue(select) };
  const notifications = { notifyNow: jest.fn().mockResolvedValue(undefined) };
  const service = new OrdersService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    notifications as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { resolve: jest.fn().mockResolvedValue(null) } as never, // PaymentOptionsService,
  );
  return { service, notifications };
}

describe('OrdersService.requestLocation', () => {
  it('sends location_request with orderNumber for a delivery order', async () => {
    const { service, notifications } = createService({
      id: 'order-1',
      delivery_type: 'delivery',
      customer_id: 'customer-1',
      order_number: 'ORD-260929-007',
    });

    await service.requestLocation('order-1');

    expect(notifications.notifyNow).toHaveBeenCalledWith({
      channel: 'whatsapp',
      kind: 'location_request',
      targetRef: 'order-1',
      payload: { customerId: 'customer-1', reason: 'delivery_location', orderNumber: 'ORD-260929-007' },
    });
  });

  it('propagates a gateway failure instead of swallowing it (manual staff retry needs to know)', async () => {
    const { service, notifications } = createService({
      id: 'order-1',
      delivery_type: 'delivery',
      customer_id: 'customer-1',
      order_number: 'ORD-260929-007',
    });
    notifications.notifyNow.mockRejectedValueOnce(new Error('gateway down'));

    await expect(service.requestLocation('order-1')).rejects.toThrow('gateway down');
  });

  it('rejects a non-delivery order', async () => {
    const { service } = createService({
      id: 'order-1',
      delivery_type: 'pickup',
      customer_id: 'customer-1',
      order_number: 'ORD-260929-007',
    });

    await expect(service.requestLocation('order-1')).rejects.toThrow('El pedido no es de delivery.');
  });
});
