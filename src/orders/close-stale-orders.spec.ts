import { OrdersService } from './orders.service';

function createService() {
  const sets: Record<string, unknown>[] = [];
  const wheres: unknown[][] = [];
  const update = { set: jest.fn(), where: jest.fn(), executeTakeFirst: jest.fn() };
  update.set.mockImplementation((values: Record<string, unknown>) => {
    sets.push(values);
    return update;
  });
  update.where.mockImplementation((...args: unknown[]) => {
    wheres.push(args);
    return update;
  });
  update.executeTakeFirst.mockResolvedValue({ numUpdatedRows: BigInt(2) });
  const db = { updateTable: jest.fn().mockReturnValue(update) };
  const service = new (OrdersService as unknown as new (...args: unknown[]) => OrdersService)(
    db,
    ...Array.from({ length: 16 }, () => ({})),
  );
  return { service, sets, wheres };
}

describe('OrdersService.closeStaleOrders', () => {
  it('despacha delivery y entrega recojo y mesa, y suma lo cerrado', async () => {
    const { service, sets } = createService();

    const closed = await service.closeStaleOrders(12);

    expect(closed).toBe(6);
    expect(sets.map((s) => s.status)).toEqual(['out_for_delivery', 'delivered', 'delivered']);
    expect(sets.every((s) => s.status_updated_by === 'system')).toBe(true);
  });
});
