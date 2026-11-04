import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { AppConfig } from '../src/config/configuration';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import { dateInBolivia } from '../src/common/time/service-window';
import { Database } from '../src/database/types';
import { DeliveryService } from '../src/delivery/delivery.service';
import { ALL_AVAILABLE } from '../src/operational-settings/availability.fixtures';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentOptionsService } from '../src/payment-options/payment-options.service';
import { ReservationsService } from '../src/tables/reservations.service';
import { createTestDb, describeIfDb } from './utils/test-db';

/**
 * Pedido de "mesa" simple + reservas por personas del día, contra Postgres real con migraciones aplicadas (incluida
 * 1700000018000):
 *   DATABASE_URL=... npm run migrate:up
 *   DATABASE_URL=... npm run test:e2e -- dine-in-reservations
 *
 * Demuestra lo que los mocks no pueden: que el cupo del día aguanta solicitudes simultáneas (nunca se pasa del máximo), que el
 * adelanto se descuenta UNA sola vez aunque dos pedidos lo intenten a la vez, y que el pedido nace neto del crédito en la misma
 * transacción que marca la reserva como usada. El QR del adelanto va con un stub. Usa una base de PRUEBA.
 */
describeIfDb('Mesa simple y reservas por personas (integración)', () => {
  const RUN = String(Date.now());
  const key = (suffix: string) => `e2e-dinein-${RUN}-${suffix}`;

  let db: Kysely<Database>;
  let orders: OrdersService;
  let reservations: ReservationsService;
  let productId: string;
  let previousSettings: Record<string, unknown>;
  const categoryIds: string[] = [];
  const productIds: string[] = [];
  const reservationIds: string[] = [];
  const orderIds: string[] = [];
  let seq = 0;
  let sessionId: string;
  let seededSession = false;

  // Mañana y pasado mañana en hora de Bolivia: dentro de la anticipación mínima y del máximo de días.
  const dayOffset = (days: number) => dateInBolivia(new Date(Date.now() + days * 24 * 60 * 60_000));
  const DAY_A = dayOffset(2);
  const DAY_B = dayOffset(3);

  const posOrder = async (items: number, extra: Record<string, unknown> = {}, channel: 'pos' | 'whatsapp' = 'pos') => {
    const outcome = await orders.create(
      {
        channel,
        customerName: 'Mesa',
        deliveryType: 'dine_in',
        paymentMethod: 'qr',
        items: [{ productId, quantity: items }],
        ...extra,
      } as never,
      key(`o${++seq}`),
      channel === 'pos' ? 'pos' : 'whatsapp-gateway',
    );
    const body = outcome.body as { id: string };
    orderIds.push(body.id);
    return outcome.body as unknown as Record<string, unknown> & { id: string };
  };

  const orderRow = (id: string) =>
    db
      .selectFrom('orders')
      .select(['id', 'status', 'payment_status', 'payment_method', 'subtotal_amount', 'total_amount', 'deposit_credit_amount', 'table_id'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  /** Primer horario libre de ese día para un grupo. */
  async function firstSlot(date: string, party: number): Promise<string | null> {
    const availability = await reservations.availability(date, party);
    return availability.slots[0]?.startsAt ?? null;
  }

  async function reserve(date: string, party: number, name = 'Ana') {
    const startsAt = await firstSlot(date, party);
    if (!startsAt) throw new Error(`sin horario para ${party} personas el ${date}`);
    const outcome = await reservations.create(
      { customerName: name, customerPhone: '+59170000000', partySize: party, startsAt } as never,
      key(`r${++seq}`),
      'web',
      'web',
    );
    reservationIds.push(outcome.body.id);
    return outcome.body;
  }

  /** Simula que el banco cobró el adelanto: el pedido del adelanto pasa a pagado y la reserva se confirma. */
  async function payDeposit(reservationId: string, depositOrderId: string) {
    await db.updateTable('orders').set({ payment_status: 'paid' }).where('id', '=', depositOrderId).execute();
    await reservations.syncPayments(reservationId);
  }

  const setMaxPeople = (value: number) => reservations.updateSettings({ maxPeoplePerDay: value });

  beforeAll(async () => {
    db = createTestDb();
    const settings = { business_opens_hour: 0, business_closes_hour: 23, open_weekdays: [0, 1, 2, 3, 4, 5, 6], ...ALL_AVAILABLE };
    const settingsStub = { getRow: async () => settings } as never;
    const config = {
      get: (name: string) =>
        name === 'baneco'
          ? { baseUrl: 'http://stub', username: 'u', password: 'p', aesKey: 'k', account: 'a' }
          : name === 'posQrMode'
            ? 'bank'
            : name === 'aiTestPhones'
              ? []
              : 10,
    } as unknown as ConfigService<AppConfig, true>;

    const existingOpen = await db.selectFrom('cash_register_sessions').select('id').where('status', '=', 'open').executeTakeFirst();
    if (existingOpen) sessionId = existingOpen.id;
    else {
      const seeded = await db.insertInto('cash_register_sessions').values({ opened_by: 'dine-in-reservations.e2e-spec', opening_amount: '0' }).returning('id').executeTakeFirstOrThrow();
      sessionId = seeded.id;
      seededSession = true;
    }
    const cashRegister = { isOpen: async () => true, sessionIdForPayment: async () => sessionId, openSessionIdOrNull: async () => sessionId };
    const idempotency = new IdempotencyService(db);

    orders = new OrdersService(
      db,
      idempotency,
      settingsStub,
      new DeliveryService(db, {} as never, {} as never, settingsStub),
      { notifyNow: async () => undefined } as never,
      cashRegister as never,
      { generateForOrder: async () => ({}), cancelForOrder: async () => undefined } as never,
      config,
      { notifyConfirmed: async () => undefined } as never,
      new PaymentOptionsService(db, settingsStub, config),
    );
    reservations = new ReservationsService(
      db,
      idempotency,
      { generateForOrder: async () => ({}), cancelForOrder: async () => undefined } as never,
      settingsStub,
    );
    previousSettings = (await db.selectFrom('reservation_settings').selectAll().executeTakeFirstOrThrow()) as unknown as Record<string, unknown>;
    await reservations.updateSettings({ enabled: true, depositAmount: 100, maxPeoplePerDay: 30 });

    const category = await db.insertInto('categories').values({ name: `e2e-dinein-cat-${RUN}` }).returning('id').executeTakeFirstOrThrow();
    categoryIds.push(category.id);
    const product = await db.insertInto('products').values({ code: `e2e-dinein-${RUN}`, name: 'Producto e2e', category_id: category.id, price: '20.00' }).returning('id').executeTakeFirstOrThrow();
    productIds.push(product.id);
    productId = product.id;
  });

  afterAll(async () => {
    if (reservationIds.length) {
      const rows = await db.selectFrom('reservations').select(['deposit_order_id']).where('id', 'in', reservationIds).execute();
      await db.deleteFrom('reservations').where('id', 'in', reservationIds).execute();
      const depositIds = rows.map((r) => r.deposit_order_id).filter((id): id is string => id !== null);
      orderIds.push(...depositIds);
    }
    if (orderIds.length) {
      await db.deleteFrom('payment_attempts').where('order_id', 'in', orderIds).execute();
      await db.deleteFrom('bank_qr_charges').where('order_id', 'in', orderIds).execute();
      await db.deleteFrom('orders').where('id', 'in', orderIds).execute();
    }
    await db.deleteFrom('idempotency_keys').where('idempotency_key', 'like', `e2e-dinein-${RUN}-%`).execute();
    if (productIds.length) await db.deleteFrom('products').where('id', 'in', productIds).execute();
    if (categoryIds.length) await db.deleteFrom('categories').where('id', 'in', categoryIds).execute();
    if (seededSession) await db.deleteFrom('cash_register_sessions').where('id', '=', sessionId).execute();
    await reservations.updateSettings({
      enabled: previousSettings.enabled as boolean,
      depositAmount: Number(previousSettings.deposit_amount),
      maxPeoplePerDay: previousSettings.max_people_per_day as number,
    });
    await db.destroy();
  });

  describe('pedido de "mesa" simple', () => {
    it('el POS lo crea sin mesa ni cuenta: queda confirmado y sin pagar, como uno de recojo', async () => {
      const order = await posOrder(2);
      const row = await orderRow(order.id);

      expect(row).toMatchObject({ status: 'confirmed', payment_status: 'unpaid', table_id: null });
      expect(Number(row.total_amount)).toBe(40);
      expect(Number(row.deposit_credit_amount)).toBe(0);
    });

    it('el agente (whatsapp) no toma pedidos de mesa', async () => {
      await expect(posOrder(1, {}, 'whatsapp')).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('reservationId solo vale en un pedido de mesa del POS', async () => {
      await expect(
        orders.create(
          { channel: 'pos', customerName: 'X', deliveryType: 'pickup', paymentMethod: 'qr', items: [{ productId, quantity: 1 }], reservationId: '11111111-1111-4111-8111-111111111111' } as never,
          key('rid'),
          'pos',
        ),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });
  });

  describe('cupo de personas por día', () => {
    it('ofrece horarios mientras el grupo quepa, y ninguno cuando se pasaría del máximo', async () => {
      await setMaxPeople(10);
      expect(await firstSlot(DAY_A, 4)).not.toBeNull();

      await reserve(DAY_A, 4);

      expect(await firstSlot(DAY_A, 6)).not.toBeNull(); // 4 + 6 = 10: justo en el tope
      expect(await firstSlot(DAY_A, 7)).toBeNull(); // 4 + 7 = 11: no cabe
    });

    it('una reserva que pasaría el máximo se rechaza con no_availability', async () => {
      // Se fuerza la creación directa con un horario válido (la disponibilidad ya no lo ofrece para 7).
      const startsAt = (await reservations.availability(DAY_A, 1)).slots[0].startsAt;
      await expect(
        reservations.create({ customerName: 'Luis', customerPhone: '+59170000001', partySize: 7, startsAt } as never, key('over'), 'web', 'web'),
      ).rejects.toMatchObject({ code: 'no_availability' });
    });

    it('el cupo es por DÍA: otro día no se ve afectado', async () => {
      expect(await firstSlot(DAY_B, 10)).not.toBeNull();
    });

    it('un grupo mayor al máximo del día se rechaza con party_too_large', async () => {
      const startsAt = (await reservations.availability(DAY_B, 1)).slots[0].startsAt;
      await expect(
        reservations.create({ customerName: 'Grupo', customerPhone: '+59170000002', partySize: 11, startsAt } as never, key('big'), 'web', 'web'),
      ).rejects.toMatchObject({ code: 'party_too_large' });
    });

    it('cancelar una reserva libera sus lugares', async () => {
      await setMaxPeople(10);
      const full = await reserve(DAY_B, 10);
      expect(await firstSlot(DAY_B, 1)).toBeNull();

      await reservations.cancel(full.id, { reason: 'e2e', actor: 'e2e' });

      expect(await firstSlot(DAY_B, 10)).not.toBeNull();
    });

    it('el máximo sale del ajuste', async () => {
      await setMaxPeople(3);
      expect((await reservations.getSettings()).maxPeoplePerDay).toBe(3);
      expect((await reservations.availability(dayOffset(4), 4)).slots).toHaveLength(0);
    });

    it('solicitudes simultáneas nunca pasan del cupo: con máximo 10 y grupos de 4 entran exactamente 2', async () => {
      await setMaxPeople(10);
      const day = dayOffset(5);
      const startsAt = (await reservations.availability(day, 4)).slots[0].startsAt;

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          reservations.create({ customerName: `Par ${i}`, customerPhone: '+59170000003', partySize: 4, startsAt } as never, key(`par${i}`), 'web', 'web'),
        ),
      );
      for (const r of results) if (r.status === 'fulfilled') reservationIds.push(r.value.body.id);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(4);
      for (const r of rejected) expect(r.reason).toMatchObject({ code: 'no_availability' });
    });
  });

  describe('adelanto de la reserva como crédito en el pedido', () => {
    async function paidReservation(party = 2) {
      await setMaxPeople(30);
      const created = await reserve(dayOffset(6), party);
      await payDeposit(created.id, created.depositOrderId as string);
      return created;
    }

    it('un consumo mayor al adelanto: el pedido nace neto y la reserva queda usada', async () => {
      const reservation = await paidReservation();
      const order = await posOrder(7, { reservationId: reservation.id }); // Bs 140 - Bs 100 de adelanto

      const row = await orderRow(order.id);
      expect(Number(row.deposit_credit_amount)).toBe(100);
      expect(Number(row.subtotal_amount)).toBe(40);
      expect(Number(row.total_amount)).toBe(40);
      expect(row.payment_status).toBe('unpaid');
      expect(order.depositCreditAmount).toBe(100);

      const used = await db.selectFrom('reservations').select(['status', 'deposit_status', 'account_order_id']).where('id', '=', reservation.id).executeTakeFirstOrThrow();
      expect(used).toMatchObject({ status: 'seated', deposit_status: 'applied', account_order_id: order.id });
    });

    it('si el adelanto cubre todo el consumo, el pedido nace pagado y no hay nada que cobrar', async () => {
      const reservation = await paidReservation();
      const order = await posOrder(3, { reservationId: reservation.id }); // Bs 60, adelanto de Bs 100

      const row = await orderRow(order.id);
      expect(Number(row.deposit_credit_amount)).toBe(60); // lo que sobra del adelanto no se devuelve ni queda a favor
      expect(Number(row.total_amount)).toBe(0);
      expect(row).toMatchObject({ payment_status: 'paid', payment_method: 'cash' });
    });

    it('una reserva se usa una sola vez', async () => {
      const reservation = await paidReservation();
      await posOrder(4, { reservationId: reservation.id });

      await expect(posOrder(4, { reservationId: reservation.id })).rejects.toMatchObject({ code: 'reservation_already_used' });
    });

    it('dos pedidos simultáneos con la misma reserva: solo uno recibe el adelanto', async () => {
      const reservation = await paidReservation();

      const results = await Promise.allSettled([
        posOrder(7, { reservationId: reservation.id }),
        posOrder(7, { reservationId: reservation.id }),
        posOrder(7, { reservationId: reservation.id }),
      ]);

      const winners = results.filter((r): r is PromiseFulfilledResult<{ id: string }> => r.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      const used = await db.selectFrom('reservations').select('account_order_id').where('id', '=', reservation.id).executeTakeFirstOrThrow();
      expect(used.account_order_id).toBe(winners[0].value.id);
      expect(Number((await orderRow(winners[0].value.id)).deposit_credit_amount)).toBe(100);
    });

    it('una reserva sin el adelanto pagado no se puede usar', async () => {
      await setMaxPeople(30);
      const unpaid = await reserve(dayOffset(7), 2);

      await expect(posOrder(4, { reservationId: unpaid.id })).rejects.toMatchObject({ code: 'reservation_not_usable' });
    });

    it('una reserva cancelada no se puede usar', async () => {
      const reservation = await paidReservation();
      await reservations.cancel(reservation.id, { reason: 'e2e', actor: 'e2e' });

      await expect(posOrder(4, { reservationId: reservation.id })).rejects.toMatchObject({ code: 'reservation_not_usable' });
    });

    it('una reserva que no existe da 404', async () => {
      await expect(posOrder(4, { reservationId: '22222222-2222-4222-8222-222222222222' })).rejects.toMatchObject({ code: 'not_found' });
    });

    it('un pedido de mesa sin reserva no lleva crédito', async () => {
      const order = await posOrder(3);

      expect(order.depositCreditAmount).toBe(0);
      expect(Number((await orderRow(order.id)).total_amount)).toBe(60);
    });
  });
});
