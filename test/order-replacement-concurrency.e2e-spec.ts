import { Kysely } from 'kysely';
import { ALL_AVAILABLE } from '../src/operational-settings/availability.fixtures';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../src/config/configuration';
import { DomainException } from '../src/common/exceptions/domain-exception';
import { Database } from '../src/database/types';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentOptionsService } from '../src/payment-options/payment-options.service';
import { PaymentAttemptsService } from '../src/payment-attempts/payment-attempts.service';
import { CashRegisterService } from '../src/cash-register/cash-register.service';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import { OrderReplacementService } from '../src/order-replacement/order-replacement.service';
import { createTestDb, describeIfDb } from './utils/test-db';

const noop = { notifyNow: async () => undefined } as never;
const noopDeliveryNotices = { notifyConfirmed: async () => undefined } as never;
const alwaysOpen = { getRow: async () => ({ business_opens_hour: 0, business_closes_hour: 23, ...ALL_AVAILABLE }) } as never;
const config = { get: () => 10 } as unknown as ConfigService<AppConfig, true>;

/**
 * FASE 3 — la carrera entre PaymentAttemptsService.decide() (el banco
 * confirmando un pago) y OrderReplacementService.createReplacement() sobre
 * el MISMO pedido. Requiere Postgres real con migraciones aplicadas
 * (incluidas 1700000038000 y 1700000039000):
 *   DATABASE_URL=... npm run migrate:up
 *   DATABASE_URL=... npm run test:e2e
 *
 * El invariante no es "quién gana" (eso lo decide el timing real, no el
 * test) sino que el resultado NUNCA deja un pedido cancelado marcado como
 * pagado, ni un pago aplicado sobre un pedido que dejó de ser el activo del
 * cliente. Se prueban las dos direcciones de forma determinística
 * (secuencial, ver tests 1 y 2 — cada una ejerce el guard real contra
 * Postgres) más una carrera genuinamente concurrente (test 3) que además
 * prueba que no hay deadlock entre ambos flujos.
 */
describeIfDb('OrderReplacementService vs PaymentAttemptsService (integración, concurrencia)', () => {
  let db: Kysely<Database>;
  let orders: OrdersService;
  let paymentAttempts: PaymentAttemptsService;
  let replacement: OrderReplacementService;
  let seededSessionId: string | null = null;
  const RUN = String(Date.now());
  let seq = 0;

  beforeAll(async () => {
    db = createTestDb();
    const cashRegister = new CashRegisterService(db);
    orders = new OrdersService(
      db,
      {} as never,
      alwaysOpen,
      {} as never, // DeliveryService: no se ejercita, los pedidos de este spec son pickup
      noop,
      {} as never,
      {} as never,
      config,
      noopDeliveryNotices,
      new PaymentOptionsService(db, {} as never, {} as never),
    );
    paymentAttempts = new PaymentAttemptsService(db, noop, cashRegister, noopDeliveryNotices);
    replacement = new OrderReplacementService(
      db,
      new IdempotencyService(db),
      alwaysOpen,
      { isOpen: async () => true } as never, // el gate de horario/caja de createReplacement, no el de decide()
      orders,
    );

    const existingOpen = await db
      .selectFrom('cash_register_sessions')
      .select('id')
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (!existingOpen) {
      const seededRow = await db
        .insertInto('cash_register_sessions')
        .values({ opened_by: 'order-replacement-concurrency.e2e-spec', opening_amount: '0' })
        .returning('id')
        .executeTakeFirstOrThrow();
      seededSessionId = seededRow.id;
    }
  });

  afterAll(async () => {
    if (seededSessionId) {
      await db.deleteFrom('cash_register_sessions').where('id', '=', seededSessionId).execute();
    }
    await db.destroy();
  });

  async function seedFixture(channel: 'whatsapp' | 'web' = 'whatsapp') {
    const category = await db
      .insertInto('categories')
      .values({ name: `e2e-repl-cat-${RUN}-${++seq}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    const product = await db
      .insertInto('products')
      .values({ code: `e2e-repl-${RUN}-${seq}`, name: 'Producto e2e', category_id: category.id, price: '10.00' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const customer = await db
      .insertInto('customers')
      .values({ phone: `+59199${RUN.slice(-6)}${String(++seq).padStart(2, '0')}`, name: 'e2e-repl', email: null })
      .returning(['id', 'phone'])
      .executeTakeFirstOrThrow();
    const order = await db
      .insertInto('orders')
      .values({
        order_number: `ORD-E2E-REPL-${RUN}-${seq}`,
        customer_id: customer.id,
        channel,
        customer_name: 'e2e-repl',
        delivery_type: 'pickup',
        payment_method: 'qr',
        status: 'confirmed',
        payment_status: 'unpaid',
        subtotal_amount: '10.00',
        total_amount: '10.00',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const attempt = await db
      .insertInto('payment_attempts')
      .values({ order_id: order.id, customer_id: customer.id })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { categoryId: category.id, productId: product.id, customer, orderId: order.id, attempt };
  }

  async function cleanup(f: Awaited<ReturnType<typeof seedFixture>>) {
    // replaces_order_id/replaced_by_order_id son una referencia mutua entre
    // el pedido viejo y el nuevo — hay que romper el ciclo antes de borrar.
    await db.updateTable('orders').set({ replaced_by_order_id: null }).where('id', '=', f.orderId).execute();
    await db.deleteFrom('payment_attempts').where('order_id', '=', f.orderId).execute();
    await db.deleteFrom('orders').where('replaces_order_id', '=', f.orderId).execute();
    await db.deleteFrom('orders').where('id', '=', f.orderId).execute();
    await db.deleteFrom('customers').where('id', '=', f.customer.id).execute();
    await db.deleteFrom('products').where('id', '=', f.productId).execute();
    await db.deleteFrom('categories').where('id', '=', f.categoryId).execute();
  }

  const replacementDto = (f: Awaited<ReturnType<typeof seedFixture>>) => ({
    customerPhone: f.customer.phone as string,
    orderId: f.orderId,
    customerName: 'e2e-repl',
    deliveryType: 'pickup' as const,
    paymentMethod: 'qr' as const,
    items: [{ productId: f.productId, quantity: 1 }],
    promotions: [],
  });

  it('pago gana primero: el replacement posterior ve el pedido ya pagado y no lo toca', async () => {
    const f = await seedFixture();
    try {
      const decided = await paymentAttempts.decide(f.attempt.id, 'accepted');
      expect(decided.won).toBe(true);

      const result = await replacement.createReplacement(replacementDto(f), `e2e-repl-${RUN}-${++seq}`, 'whatsapp-gateway', 'whatsapp');
      expect(result.body).toEqual({ result: 'not_replaceable', reasonCode: 'already_paid' });

      const final = await db
        .selectFrom('orders')
        .select(['status', 'payment_status', 'replaced_by_order_id'])
        .where('id', '=', f.orderId)
        .executeTakeFirstOrThrow();
      expect(final.payment_status).toBe('paid');
      expect(final.status).not.toBe('cancelled');
      expect(final.replaced_by_order_id).toBeNull();
    } finally {
      await cleanup(f);
    }
  });

  it('replacement gana primero: el pago tardío no revive el pedido cancelado (va a resolución humana, nunca a paid)', async () => {
    const f = await seedFixture();
    try {
      const result = await replacement.createReplacement(replacementDto(f), `e2e-repl-${RUN}-${++seq}`, 'whatsapp-gateway', 'whatsapp');
      expect(result.body.result).toBe('replaced');

      await expect(paymentAttempts.decide(f.attempt.id, 'accepted')).rejects.toMatchObject({
        code: 'order_not_payable',
      });

      const final = await db
        .selectFrom('orders')
        .select(['status', 'payment_status', 'replaced_by_order_id'])
        .where('id', '=', f.orderId)
        .executeTakeFirstOrThrow();
      // El pedido viejo queda exactamente como lo dejó el replacement: cancelado,
      // impago, jamás "revivido" como pagado ni empujado a operación.
      expect(final.status).toBe('cancelled');
      expect(final.payment_status).toBe('unpaid');
      expect(final.replaced_by_order_id).not.toBeNull();
    } finally {
      await cleanup(f);
    }
  });

  it('carrera real (Promise.all): sin deadlock, y el resultado siempre respeta el invariante sea quien sea el que gane', async () => {
    const f = await seedFixture();
    try {
      const [decideOutcome, replacementOutcome] = await Promise.allSettled([
        paymentAttempts.decide(f.attempt.id, 'accepted'),
        replacement.createReplacement(replacementDto(f), `e2e-repl-${RUN}-${++seq}`, 'whatsapp-gateway', 'whatsapp'),
      ]);

      const final = await db
        .selectFrom('orders')
        .select(['status', 'payment_status', 'replaced_by_order_id'])
        .where('id', '=', f.orderId)
        .executeTakeFirstOrThrow();

      if (final.payment_status === 'paid') {
        // El banco ganó la carrera de commits.
        expect(final.status).not.toBe('cancelled');
        expect(final.replaced_by_order_id).toBeNull();
        if (replacementOutcome.status === 'fulfilled') {
          expect(replacementOutcome.value.body.result).not.toBe('replaced');
        }
      } else {
        // El replacement ganó la carrera de commits.
        expect(final.status).toBe('cancelled');
        expect(final.replaced_by_order_id).not.toBeNull();
        if (decideOutcome.status === 'rejected') {
          expect((decideOutcome.reason as DomainException).code).toBe('order_not_payable');
        }
      }
    } finally {
      await cleanup(f);
    }
  });

  it('doble click: dos replacements concurrentes sobre el mismo pedido -> exactamente uno lo reemplaza', async () => {
    const f = await seedFixture();
    try {
      const dto = replacementDto(f);
      const [a, b] = await Promise.allSettled([
        replacement.createReplacement(dto, `e2e-repl-${RUN}-${++seq}`, 'whatsapp-gateway', 'whatsapp'),
        replacement.createReplacement(dto, `e2e-repl-${RUN}-${++seq}`, 'whatsapp-gateway', 'whatsapp'),
      ]);
      const results = [a, b].map((r) => (r.status === 'fulfilled' ? r.value.body.result : 'threw'));
      expect(results.filter((r) => r === 'replaced')).toHaveLength(1);
      expect(results.filter((r) => r === 'stale_order')).toHaveLength(1);

      const replacements = await db
        .selectFrom('orders')
        .select('id')
        .where('replaces_order_id', '=', f.orderId)
        .execute();
      // Respaldado además por el índice único parcial de 1700000039000.
      expect(replacements).toHaveLength(1);
    } finally {
      await cleanup(f);
    }
  });

  it('idempotencia: reintentar el mismo replacement con la misma Idempotency-Key no crea un segundo pedido', async () => {
    const f = await seedFixture();
    try {
      const idemKey = `e2e-repl-${RUN}-${++seq}`;
      const first = await replacement.createReplacement(replacementDto(f), idemKey, 'whatsapp-gateway', 'whatsapp');
      const second = await replacement.createReplacement(replacementDto(f), idemKey, 'whatsapp-gateway', 'whatsapp');
      expect(second.body).toEqual(first.body);

      const replacements = await db
        .selectFrom('orders')
        .select('id')
        .where('replaces_order_id', '=', f.orderId)
        .execute();
      expect(replacements).toHaveLength(1);
    } finally {
      await cleanup(f);
    }
  });

  it('canal web: el reemplazo nace channel=web, trae orderNumber y no copia ubicación', async () => {
    const f = await seedFixture('web');
    try {
      const result = await replacement.createReplacement(replacementDto(f), `e2e-repl-${RUN}-${++seq}`, 'web', 'web');
      expect(result.body.result).toBe('replaced');
      if (result.body.result !== 'replaced') throw new Error('unreachable');
      expect(result.body.orderNumber).toBeTruthy();

      const created = await db
        .selectFrom('orders')
        .select(['channel', 'status', 'delivery_latitude'])
        .where('id', '=', result.body.orderId)
        .executeTakeFirstOrThrow();
      expect(created.channel).toBe('web');
      // pickup en este fixture, así que ni aplica cotizar ubicación — el punto
      // es que applyLocationLocked ni se invoca (no hay location_conflict
      // posible porque no se copió nada).
      expect(created.delivery_latitude).toBeNull();
      // cleanup(f) rompe el ciclo de FK (replaced_by_order_id) y borra el
      // nuevo pedido vía `replaces_order_id = f.orderId` — no hace falta
      // borrarlo a mano acá.
    } finally {
      await cleanup(f);
    }
  });

  it('aislamiento de canal real: un pedido activo de whatsapp es invisible para una llamada web (not_found, nunca lo toca)', async () => {
    const f = await seedFixture('whatsapp');
    try {
      const result = await replacement.createReplacement(replacementDto(f), `e2e-repl-${RUN}-${++seq}`, 'web', 'web');
      expect(result.body).toEqual({ result: 'not_found' });

      const untouched = await db
        .selectFrom('orders')
        .select(['status', 'replaced_by_order_id'])
        .where('id', '=', f.orderId)
        .executeTakeFirstOrThrow();
      expect(untouched.status).not.toBe('cancelled');
      expect(untouched.replaced_by_order_id).toBeNull();
    } finally {
      await cleanup(f);
    }
  });
});
