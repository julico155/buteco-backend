import { DeliveryDriversService } from './delivery-drivers.service';

const driver = { sub: 'driver-1', username: 'moto1', role: 'delivery' as const };

/** Query builder falso: cualquier método de encadenado se devuelve a sí mismo; los terminales resuelven `result`. */
function chain(result: unknown) {
  const obj: Record<string, jest.Mock> = {};
  for (const method of ['select', 'where', '$if', 'orderBy', 'limit', 'offset', 'set', 'returning']) {
    obj[method] = jest.fn(() => obj);
  }
  obj.execute = jest.fn().mockResolvedValue(Array.isArray(result) ? result : []);
  obj.executeTakeFirst = jest.fn().mockResolvedValue(result);
  obj.executeTakeFirstOrThrow = jest.fn().mockResolvedValue(result);
  return obj;
}

describe('DeliveryDriversService.deliver', () => {
  function createService(order: {
    id: string;
    status: string;
    delivery_driver_id: string;
    payment_method: 'cash' | 'qr';
    payment_status: 'unpaid' | 'paid';
  }) {
    const orderChain = chain(order);
    const updateChain = chain({ id: order.id });
    const db = {
      selectFrom: jest.fn(() => orderChain),
      updateTable: jest.fn(() => updateChain),
    };
    const service = new DeliveryDriversService(db as never, {} as never, {} as never);
    return { service, updateChain };
  }

  it('confirma el pago (cash, default) en el mismo golpe que delivered', async () => {
    const { service, updateChain } = createService({
      id: 'order-1',
      status: 'out_for_delivery',
      delivery_driver_id: 'driver-1',
      payment_method: 'cash',
      payment_status: 'unpaid',
    });

    await service.deliver('order-1', driver);

    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'delivered', payment_status: 'paid', cash_confirmed_at: expect.any(Date) }),
    );
  });

  it('cashCollected=false entrega igual, pero NO marca paid (se le cobra a la moto después)', async () => {
    const { service, updateChain } = createService({
      id: 'order-1',
      status: 'out_for_delivery',
      delivery_driver_id: 'driver-1',
      payment_method: 'cash',
      payment_status: 'unpaid',
    });

    const result = await service.deliver('order-1', driver, false);

    expect(result.id).toBe('order-1');
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'delivered' }),
    );
    expect(updateChain.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ payment_status: 'paid' }),
    );
  });

  it('un pedido QR (ya pagado antes) no toca payment_status al entregar', async () => {
    const { service, updateChain } = createService({
      id: 'order-1',
      status: 'out_for_delivery',
      delivery_driver_id: 'driver-1',
      payment_method: 'qr',
      payment_status: 'paid',
    });

    await service.deliver('order-1', driver);

    expect(updateChain.set).toHaveBeenCalledWith({
      status: 'delivered',
      delivered_at: expect.any(Date),
      status_updated_by: 'moto1',
      updated_at: expect.any(Date),
    });
  });

  it('no reconfirma un cash que ya estaba paid (idempotente, no pisa cash_confirmed_at de nuevo)', async () => {
    const { service, updateChain } = createService({
      id: 'order-1',
      status: 'out_for_delivery',
      delivery_driver_id: 'driver-1',
      payment_method: 'cash',
      payment_status: 'paid',
    });

    await service.deliver('order-1', driver);

    expect(updateChain.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ cash_confirmed_at: expect.any(Date) }),
    );
  });

  it('rechaza si el pedido es de otro repartidor', async () => {
    const { service } = createService({
      id: 'order-1',
      status: 'out_for_delivery',
      delivery_driver_id: 'otro-driver',
      payment_method: 'cash',
      payment_status: 'unpaid',
    });

    await expect(service.deliver('order-1', driver)).rejects.toMatchObject({ code: 'not_your_order' });
  });
});

describe('DeliveryDriversService.listHistory — cuadre de efectivo', () => {
  it('separa el total de cash cobrado del pendiente (a cobrarle a la moto)', async () => {
    const totalsRow = { deliveries: '3', fees: '30', cash_collected: '85.50', cash_pending: '20.00' };
    const rows = [
      {
        id: 'o1',
        order_number: 'ORD-1',
        customer_name: 'Juan',
        delivery_driver_id: 'driver-1',
        delivery_driver_name: 'moto1',
        delivery_accepted_at: new Date(),
        delivered_at: new Date(),
        delivery_distance_meters: 1000,
        delivery_base_amount: '10',
        delivery_surcharge_amount: '0',
        payment_method: 'cash',
        payment_status: 'unpaid',
        total_amount: '20.00',
      },
    ];
    const selectFrom = jest.fn(() => {
      const c = chain(undefined);
      c.executeTakeFirstOrThrow = jest.fn().mockResolvedValue(totalsRow);
      c.execute = jest.fn().mockResolvedValue(rows);
      return c;
    });
    const db = { selectFrom };
    const service = new DeliveryDriversService(db as never, {} as never, {} as never);

    const result = await service.listHistory(
      { sub: 'admin-1', role: 'admin' } as never,
      { limit: 20, offset: 0 },
    );

    expect(result.totals.cashCollectedTotal).toBe(85.5);
    expect(result.totals.cashPendingTotal).toBe(20);
    expect(result.orders[0]).toMatchObject({
      paymentMethod: 'cash',
      paymentStatus: 'unpaid',
      totalAmount: 20,
    });
  });
});
