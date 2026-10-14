import { DomainException } from '../common/exceptions/domain-exception';
import { OrderPaymentMethod, OrderPaymentStatus } from '../database/types';
import { OrdersService } from './orders.service';

interface FakeOrder {
  id: string;
  order_number: string;
  status: string;
  delivery_type: 'delivery' | 'pickup' | 'dine_in';
  payment_method: OrderPaymentMethod;
  payment_status: OrderPaymentStatus;
  created_at: Date;
  updated_at: Date;
  delivered_at: Date | null;
}

const baseOrder: FakeOrder = {
  id: 'order-1',
  order_number: 'ORD-0001',
  status: 'confirmed',
  delivery_type: 'delivery',
  payment_method: 'cash',
  payment_status: 'unpaid',
  created_at: new Date('2026-10-06T00:00:00.000Z'),
  updated_at: new Date('2026-10-06T00:00:00.000Z'),
  delivered_at: null,
};

function createService(order: FakeOrder, cashPrepaymentRequired = false) {
  const lockedOrder = { selectAll: jest.fn(), where: jest.fn(), executeTakeFirst: jest.fn().mockResolvedValue(order) };
  lockedOrder.selectAll.mockReturnValue(lockedOrder);
  lockedOrder.where.mockReturnValue(lockedOrder);

  let written: Record<string, unknown> = {};
  const updateOrder = { set: jest.fn(), where: jest.fn(), returningAll: jest.fn() };
  updateOrder.set.mockImplementation((values: Record<string, unknown>) => {
    written = values;
    return updateOrder;
  });
  updateOrder.where.mockReturnValue(updateOrder);
  updateOrder.returningAll.mockReturnValue({
    executeTakeFirst: jest.fn().mockImplementation(() => Promise.resolve({ ...order, ...written })),
  });

  const items = { selectAll: jest.fn(), where: jest.fn(), execute: jest.fn().mockResolvedValue([]) };
  items.selectAll.mockReturnValue(items);
  items.where.mockReturnValue(items);
  const promotions = { selectAll: jest.fn(), where: jest.fn(), execute: jest.fn().mockResolvedValue([]) };
  promotions.selectAll.mockReturnValue(promotions);
  promotions.where.mockReturnValue(promotions);

  const db = {
    selectFrom: jest.fn((table: string) => {
      if (table === 'orders') return lockedOrder;
      if (table === 'order_items') return items;
      return promotions;
    }),
    updateTable: jest.fn().mockReturnValue(updateOrder),
  };
  const service = new OrdersService(
    db as never,
    {} as never,
    { getRow: jest.fn().mockResolvedValue({ cash_prepayment_required: cashPrepaymentRequired }) } as never, // OperationalSettingsService
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { resolve: jest.fn().mockResolvedValue(null) } as never, // PaymentOptionsService,
  );
  return { service, db };
}

describe('OrdersService.updateStatus — cierre manual y gate de pago', () => {
  it('delivery en efectivo sin pagar se despacha (se cobra contra entrega)', async () => {
    const { service } = createService(baseOrder);

    const result = await service.updateStatus('order-1', 'out_for_delivery', 'cajero1');
    expect(result.status).toBe('out_for_delivery');
  });

  it('recojo en efectivo se entrega', async () => {
    const { service } = createService({ ...baseOrder, delivery_type: 'pickup' });

    const result = await service.updateStatus('order-1', 'delivered', 'cajero1');
    expect(result.status).toBe('delivered');
  });

  it('mesa se entrega', async () => {
    const { service } = createService({ ...baseOrder, delivery_type: 'dine_in' });

    const result = await service.updateStatus('order-1', 'delivered', 'cajero1');
    expect(result.status).toBe('delivered');
  });

  it('un delivery no se marca como entregado, se despacha', async () => {
    const { service } = createService(baseOrder);

    await expect(service.updateStatus('order-1', 'delivered', 'cajero1')).rejects.toMatchObject({
      code: 'invalid_handover_status',
    });
  });

  it('un recojo no se marca como despachado, se entrega', async () => {
    const { service } = createService({ ...baseOrder, delivery_type: 'pickup' });

    await expect(service.updateStatus('order-1', 'out_for_delivery', 'cajero1')).rejects.toMatchObject({
      code: 'invalid_handover_status',
    });
  });

  it('preparing y ready ya no son destinos válidos', async () => {
    const { service } = createService(baseOrder);

    await expect(service.updateStatus('order-1', 'preparing', 'cajero1')).rejects.toBeInstanceOf(
      DomainException,
    );
    await expect(service.updateStatus('order-1', 'ready', 'cajero1')).rejects.toBeInstanceOf(
      DomainException,
    );
  });

  it('un pedido viejo en preparing igual se puede cerrar', async () => {
    const { service } = createService({ ...baseOrder, status: 'preparing' });

    const result = await service.updateStatus('order-1', 'out_for_delivery', 'cajero1');
    expect(result.status).toBe('out_for_delivery');
  });

  it('exige paid para QR antes de despachar', async () => {
    const { service } = createService({ ...baseOrder, payment_method: 'qr', payment_status: 'unpaid' });

    await expect(service.updateStatus('order-1', 'out_for_delivery', 'cajero1')).rejects.toMatchObject({
      code: 'payment_required',
    });
  });

  it('exige paid para split antes de entregar', async () => {
    const { service } = createService({
      ...baseOrder,
      delivery_type: 'pickup',
      payment_method: 'split',
      payment_status: 'unpaid',
    });

    await expect(service.updateStatus('order-1', 'delivered', 'cajero1')).rejects.toMatchObject({
      code: 'payment_required',
    });
  });

  it('un QR ya pagado se despacha', async () => {
    const { service } = createService({ ...baseOrder, payment_method: 'qr', payment_status: 'paid' });

    const result = await service.updateStatus('order-1', 'out_for_delivery', 'cajero1');
    expect(result.status).toBe('out_for_delivery');
  });

  it('cancelar no pasa por el gate de pago', async () => {
    const { service } = createService({ ...baseOrder, delivery_type: 'pickup' }, true);

    const result = await service.updateStatus('order-1', 'cancelled', 'cajero1');
    expect(result.status).toBe('cancelled');
  });

  describe('con cashPrepaymentRequired', () => {
    it('exige paid para efectivo de recojo', async () => {
      const { service } = createService({ ...baseOrder, delivery_type: 'pickup' }, true);

      await expect(service.updateStatus('order-1', 'delivered', 'cajero1')).rejects.toMatchObject({
        code: 'payment_required',
      });
    });

    it('exige paid para efectivo de mesa', async () => {
      const { service } = createService({ ...baseOrder, delivery_type: 'dine_in' }, true);

      await expect(service.updateStatus('order-1', 'delivered', 'cajero1')).rejects.toMatchObject({
        code: 'payment_required',
      });
    });

    it('deja pasar el efectivo presencial ya pagado', async () => {
      const { service } = createService(
        { ...baseOrder, delivery_type: 'pickup', payment_status: 'paid' },
        true,
      );

      const result = await service.updateStatus('order-1', 'delivered', 'cajero1');
      expect(result.status).toBe('delivered');
    });

    it('no afecta al efectivo de delivery (lo cobra el repartidor)', async () => {
      const { service } = createService(baseOrder, true);

      const result = await service.updateStatus('order-1', 'out_for_delivery', 'cajero1');
      expect(result.status).toBe('out_for_delivery');
    });
  });

  it('con el flag apagado (default), el efectivo de recojo se entrega sin pago previo', async () => {
    const { service } = createService({ ...baseOrder, delivery_type: 'pickup' }, false);

    const result = await service.updateStatus('order-1', 'delivered', 'cajero1');
    expect(result.status).toBe('delivered');
  });
});
