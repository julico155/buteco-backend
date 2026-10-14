import { DomainException } from '../common/exceptions/domain-exception';
import { CashRegisterService } from './cash-register.service';

/** Kysely mínimo: selectFrom(tabla) → fila según la tabla. */
function build(rows: { open?: { id: string }; settings?: { require_open_register: boolean } }) {
  const db = {
    selectFrom: (table: string) => {
      const row = table === 'cash_register_sessions' ? rows.open : rows.settings;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: Record<string, any> = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => row,
      };
      return chain;
    },
  };
  return { db: db as never, service: new CashRegisterService(db as never) };
}

describe('CashRegisterService.sessionIdForPayment', () => {
  it('con caja abierta devuelve su id, sea obligatoria o no', async () => {
    const { service, db } = build({ open: { id: 'S1' }, settings: { require_open_register: false } });
    await expect(service.sessionIdForPayment(db)).resolves.toBe('S1');
  });

  it('sin caja y obligatoria: 409 cash_register_closed', async () => {
    const { service, db } = build({ settings: { require_open_register: true } });
    const error = await service.sessionIdForPayment(db).catch((e) => e);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe('cash_register_closed');
    expect((error as DomainException).getStatus()).toBe(409);
  });

  it('sin caja y NO obligatoria: devuelve null y el pago sigue', async () => {
    const { service, db } = build({ settings: { require_open_register: false } });
    await expect(service.sessionIdForPayment(db)).resolves.toBeNull();
  });
});
