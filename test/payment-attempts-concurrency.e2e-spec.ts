import { Kysely } from 'kysely';
import { PaymentAttemptsService } from '../src/payment-attempts/payment-attempts.service';
import { NotificationsOutService } from '../src/notifications-out/notifications-out.service';
import { CashRegisterService } from '../src/cash-register/cash-register.service';
import { DeliveryNoticesService } from '../src/delivery-notices/delivery-notices.service';
import { Database } from '../src/database/types';
import { createTestDb, describeIfDb } from './utils/test-db';

/** Los pedidos de este fixture no tienen customer_id, así que el aviso
 * best-effort nunca se dispara — un stub basta. */
const noopNotifications = { notifyNow: async () => undefined } as unknown as NotificationsOutService;
const noopDeliveryNotices = {
  notifyConfirmed: async () => undefined,
} as unknown as DeliveryNoticesService;

/**
 * Invariantes 5 y 6 del plan:
 *   5. El efecto de un CAS solo se dispara si ESA llamada ganó la
 *      transición, nunca si el estado final ya era ese por otra vía.
 *   6. Como máximo un intento de pago "vivo" por pedido, garantizado por el
 *      índice único parcial uq_payment_attempts_live (migración
 *      1700000007000_payments).
 *
 * Requiere Postgres real con migraciones aplicadas:
 *   DATABASE_URL=... npm run migrate:up
 *   DATABASE_URL=... npm run test:e2e
 */
describeIfDb('PaymentAttemptsService.decide (integración, concurrencia)', () => {
  let db: Kysely<Database>;
  let service: PaymentAttemptsService;
  // `decide('accepted')` ahora exige una caja abierta (vincula el pedido a
  // la sesión, ver CashRegisterService.sessionIdForPayment) — si el test
  // corre contra una base sin ninguna abierta, se siembra una acá y se
  // borra al final; si ya había una real abierta, se respeta y no se toca.
  let seededSessionId: string | null = null;

  beforeAll(async () => {
    db = createTestDb();
    service = new PaymentAttemptsService(
      db,
      noopNotifications,
      new CashRegisterService(db),
      noopDeliveryNotices,
    );

    const existingOpen = await db
      .selectFrom('cash_register_sessions')
      .select('id')
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (!existingOpen) {
      const seeded = await db
        .insertInto('cash_register_sessions')
        .values({ opened_by: 'payment-attempts-concurrency.e2e-spec', opening_amount: '0' })
        .returning('id')
        .executeTakeFirstOrThrow();
      seededSessionId = seeded.id;
    }
  });

  afterAll(async () => {
    if (seededSessionId) {
      await db.deleteFrom('cash_register_sessions').where('id', '=', seededSessionId).execute();
    }
    await db.destroy();
  });

  async function seedOrderWithPendingAttempt() {
    const category = await db
      .insertInto('categories')
      .values({ name: `test-cat-${Date.now()}` })
      .returning('id')
      .executeTakeFirstOrThrow();

    const product = await db
      .insertInto('products')
      .values({
        code: `test-${Date.now()}`,
        name: 'Producto de test',
        category_id: category.id,
        price: '10.00',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const order = await db
      .insertInto('orders')
      .values({
        order_number: `ORD-TEST-${Date.now()}`,
        channel: 'pos',
        customer_name: 'Cliente de test',
        delivery_type: 'pickup',
        payment_method: 'qr',
        subtotal_amount: '10.00',
        total_amount: '10.00',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const attempt = await db
      .insertInto('payment_attempts')
      .values({ order_id: order.id })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { categoryId: category.id, productId: product.id, orderId: order.id, attempt };
  }

  async function cleanup(fixture: { orderId: string; productId: string; categoryId: string }) {
    await db.deleteFrom('payment_attempts').where('order_id', '=', fixture.orderId).execute();
    await db.deleteFrom('orders').where('id', '=', fixture.orderId).execute();
    await db.deleteFrom('products').where('id', '=', fixture.productId).execute();
    await db.deleteFrom('categories').where('id', '=', fixture.categoryId).execute();
  }

  it('dos decisiones simultáneas sobre el mismo intento -> exactamente un won', async () => {
    const fixture = await seedOrderWithPendingAttempt();
    try {
      const [a, b] = await Promise.all([
        service.decide(fixture.attempt.id, 'accepted'),
        service.decide(fixture.attempt.id, 'rejected'),
      ]);

      const winners = [a, b].filter((r) => r.won);
      expect(winners).toHaveLength(1);

      // La decisión final persistida es la del ganador del CAS, no una
      // mezcla de ambas llamadas.
      const winner = winners[0];
      const loser = [a, b].find((r) => !r.won)!;
      expect(loser.attempt.reviewStatus).toBe(winner.attempt.reviewStatus);

      const final = await db
        .selectFrom('payment_attempts')
        .selectAll()
        .where('id', '=', fixture.attempt.id)
        .executeTakeFirstOrThrow();
      expect(final.review_status).toBe(winner.attempt.reviewStatus);
    } finally {
      await cleanup(fixture);
    }
  });

  it('decidir un intento ya decidido nunca vuelve a ganar el CAS', async () => {
    const fixture = await seedOrderWithPendingAttempt();
    try {
      const first = await service.decide(fixture.attempt.id, 'accepted');
      expect(first.won).toBe(true);

      const second = await service.decide(fixture.attempt.id, 'rejected');
      expect(second.won).toBe(false);
      expect(second.attempt.reviewStatus).toBe('accepted');
    } finally {
      await cleanup(fixture);
    }
  });

  it('el índice único parcial impide un segundo intento vivo para el mismo pedido', async () => {
    const fixture = await seedOrderWithPendingAttempt();
    try {
      await expect(
        db.insertInto('payment_attempts').values({ order_id: fixture.orderId }).execute(),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture);
    }
  });
});
