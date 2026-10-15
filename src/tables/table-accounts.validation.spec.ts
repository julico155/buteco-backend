import { TableAccountsService } from './table-accounts.service';

function createService() {
  const idempotency = { run: jest.fn() };
  const service = new TableAccountsService(
    {} as never,
    {} as never,
    idempotency as never,
    {} as never,
    {} as never,
  );
  return { service, idempotency };
}

describe('TableAccountsService.addRound — validaciones previas', () => {
  it('rechaza una ronda vacía sin tocar la base', async () => {
    const { service, idempotency } = createService();

    await expect(service.addRound('table-1', {}, 'key-1', 'cajero1')).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(idempotency.run).not.toHaveBeenCalled();
  });

  it('rechaza líneas duplicadas del mismo producto y selección', async () => {
    const { service, idempotency } = createService();
    const line = { productId: 'p1', quantity: 1, excludedComplements: ['cebolla'] };

    await expect(
      service.addRound('table-1', { items: [line, { ...line, quantity: 2 }] }, 'key-1', 'cajero1'),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(idempotency.run).not.toHaveBeenCalled();
  });

  it('acepta el mismo producto con distinta selección de complementos', async () => {
    const { service, idempotency } = createService();
    idempotency.run.mockResolvedValue({ created: true, status: 201, body: { orderId: 'o1' } });

    const result = await service.addRound(
      'table-1',
      {
        items: [
          { productId: 'p1', quantity: 1, excludedComplements: ['cebolla'] },
          { productId: 'p1', quantity: 1 },
        ],
      },
      'key-1',
      'cajero1',
    );

    expect(result.created).toBe(true);
    expect(idempotency.run).toHaveBeenCalledTimes(1);
  });
});
