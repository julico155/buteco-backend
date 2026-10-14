import { DomainException } from '../common/exceptions/domain-exception';
import { DeliveryTariffService } from './delivery-tariff.service';

function createService(storedRows: { band_index: number; max_distance_meters: number; fee_amount: string }[] = []) {
  const inserted: Record<string, unknown>[][] = [];
  const calls: string[] = [];

  const trx = {
    deleteFrom: jest.fn(() => ({
      execute: jest.fn(async () => {
        calls.push('delete');
      }),
    })),
    insertInto: jest.fn(() => ({
      values: jest.fn((rows: Record<string, unknown>[]) => {
        inserted.push(rows);
        return {
          execute: jest.fn(async () => {
            calls.push('insert');
          }),
        };
      }),
    })),
    selectFrom: jest.fn(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: Record<string, any> = {
        selectAll: () => chain,
        orderBy: () => chain,
        execute: async () => storedRows,
      };
      return chain;
    }),
  };
  const db = {
    ...trx,
    transaction: jest.fn(() => ({ execute: (cb: (t: typeof trx) => Promise<unknown>) => cb(trx) })),
  };
  return { service: new DeliveryTariffService(db as never), db, inserted, calls };
}

describe('DeliveryTariffService.replaceBands', () => {
  it('valida antes de abrir la transacción: una lista inválida no toca la base', async () => {
    const { service, db } = createService();

    await expect(
      service.replaceBands([
        { maxDistanceMeters: 3000, feeAmount: 9 },
        { maxDistanceMeters: 1000, feeAmount: 5 },
      ]),
    ).rejects.toBeInstanceOf(DomainException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('borra y vuelve a insertar con band_index por posición, en una transacción', async () => {
    const { service, db, inserted, calls } = createService([
      { band_index: 1, max_distance_meters: 1000, fee_amount: '5.00' },
      { band_index: 2, max_distance_meters: 4000, fee_amount: '12.50' },
    ]);

    const result = await service.replaceBands([
      { maxDistanceMeters: 1000, feeAmount: 5 },
      { maxDistanceMeters: 4000, feeAmount: 12.5 },
    ]);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['delete', 'insert']);
    expect(inserted[0]).toEqual([
      { band_index: 1, max_distance_meters: 1000, fee_amount: '5.00' },
      { band_index: 2, max_distance_meters: 4000, fee_amount: '12.50' },
    ]);
    expect(result).toEqual([
      { bandIndex: 1, maxDistanceMeters: 1000, feeAmount: 5 },
      { bandIndex: 2, maxDistanceMeters: 4000, feeAmount: 12.5 },
    ]);
  });

  it('listBands devuelve [] sin lanzar cuando no hay bandas (a diferencia de getBands)', async () => {
    const { service } = createService([]);

    await expect(service.listBands()).resolves.toEqual([]);
    await expect(service.getBands()).rejects.toMatchObject({ code: 'delivery_tariff_not_configured' });
  });
});
