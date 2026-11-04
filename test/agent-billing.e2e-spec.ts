import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { assertAgentCanOrder, chargeCommission, getAvailable, getBalance, reverseCommission } from '../src/billing/agent-billing';
import { BillingService } from '../src/billing/billing.service';
import { AppConfig } from '../src/config/configuration';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import { Database } from '../src/database/types';
import { DeliveryService } from '../src/delivery/delivery.service';
import { ALL_AVAILABLE } from '../src/operational-settings/availability.fixtures';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentAttemptsService } from '../src/payment-attempts/payment-attempts.service';
import { PaymentOptionsService } from '../src/payment-options/payment-options.service';
import { createTestDb, describeIfDb } from './utils/test-db';

/**
 * Saldo prepago y comisión del agente contra Postgres real con migraciones aplicadas (incluida 1700000017000):
 *   DATABASE_URL=... npm run migrate:up
 *   DATABASE_URL=... npm run test:e2e -- agent-billing
 *
 * Demuestra lo que los mocks no pueden: que el cobro de la comisión es UNA transacción con el pago del pedido, que repetirlo no
 * descuenta dos veces, que el reverso es único, que el bloqueo cuenta los pedidos abiertos, y que una recarga confirmada suma
 * una sola vez aunque el cron corra de nuevo. El banco va con un stub. Usa una base de PRUEBA: el libro es global y de solo
 * agregar, así que la limpieza borra únicamente lo que esta corrida creó.
 */
describeIfDb('Saldo y comisión del agente (integración)', () => {
  const RUN = String(Date.now());
  const key = (suffix: string) => `e2e-billing-${RUN}-${suffix}`;

  let billingCfg = { commissionPercent: 3, overdraftLimit: 10, lowBalanceThreshold: 10, topupMinAmount: 10 };
  let bankStatus = 0;
  let qrSeq = 0;
  let sent: Array<{ kind: string; channel: string }> = [];

  let db: Kysely<Database>;
  let orders: OrdersService;
  let payments: PaymentAttemptsService;
  let billing: BillingService;
  let config: ConfigService<AppConfig, true>;
  let productId: string;
  let sessionId: string;
  let seededSession = false;
  const customerIds: string[] = [];
  const categoryIds: string[] = [];
  const productIds: string[] = [];
  const topupIds: string[] = [];
  const adjustmentIds: string[] = [];
  let seq = 0;

  const notifications = {
    notifyNow: async (job: { kind: string; channel: string }) => {
      sent.push({ kind: job.kind, channel: job.channel });
    },
  };
  const bank = {
    generateQR: async () => ({ qrId: `e2e-qr-${RUN}-${++qrSeq}`, qrImageBase64: 'aGk=', raw: { stub: true } }),
    statusQR: async () => ({ statusQrCode: bankStatus, raw: { stub: true } }),
    cancelQR: async () => undefined,
  };

  async function newCustomer() {
    const phone = `+59198${RUN.slice(-6)}${String(++seq).padStart(2, '0')}`;
    const row = await db.insertInto('customers').values({ phone, name: 'e2e-billing', email: null }).returning('id').executeTakeFirstOrThrow();
    customerIds.push(row.id);
    return row.id;
  }

  /** Pedido de recojo por QR (la comisión se calcula sobre el subtotal: `qty` × Bs 20). */
  async function agentOrder(qty: number, channel: 'whatsapp' | 'pos' = 'whatsapp', paymentMethod: 'qr' | 'cash' = 'qr') {
    const customerId = await newCustomer();
    const outcome = await orders.create(
      { customerId, channel, customerName: 'Ana', deliveryType: 'pickup', paymentMethod, items: [{ productId, quantity: qty }] } as never,
      key(`o${++seq}`),
      channel === 'whatsapp' ? 'whatsapp-gateway' : 'pos',
    );
    return (outcome.body as { id: string }).id;
  }

  const orderRow = (id: string) =>
    db.selectFrom('orders').select(['id', 'payment_status', 'status', 'agent_commission_percent', 'agent_commission_amount']).where('id', '=', id).executeTakeFirstOrThrow();

  /** Deja el saldo en un valor conocido con un ajuste (el libro solo crece). */
  async function setBalance(target: number) {
    const diff = Math.round((target - (await getBalance(db))) * 100) / 100;
    if (diff === 0) return;
    const row = await db.insertInto('balance_ledger').values({ type: 'adjustment', amount: diff.toFixed(2), note: `e2e-billing ${RUN}` }).returning('id').executeTakeFirstOrThrow();
    adjustmentIds.push(row.id);
  }

  async function payOrder(orderId: string, customerId: string | null = null) {
    const attempt = await db
      .insertInto('payment_attempts')
      .values({ order_id: orderId, customer_id: customerId, opened_as: 'normal' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return payments.decide(attempt.id, 'accepted');
  }

  beforeAll(async () => {
    db = createTestDb();
    const settings = { business_opens_hour: 0, business_closes_hour: 23, ...ALL_AVAILABLE };
    const settingsStub = { getRow: async () => settings } as never;
    config = {
      get: (name: string) =>
        name === 'agentBilling'
          ? billingCfg
          : name === 'banecoTopup'
            ? { baseUrl: 'http://stub', username: 'u', password: 'p', aesKey: 'k', account: 'a' }
            : name === 'baneco'
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
      const seeded = await db.insertInto('cash_register_sessions').values({ opened_by: 'agent-billing.e2e-spec', opening_amount: '0' }).returning('id').executeTakeFirstOrThrow();
      sessionId = seeded.id;
      seededSession = true;
    }
    const cashRegister = { isOpen: async () => true, sessionIdForPayment: async () => sessionId, openSessionIdOrNull: async () => sessionId };

    const delivery = new DeliveryService(db, {} as never, {} as never, settingsStub);
    orders = new OrdersService(
      db,
      new IdempotencyService(db),
      settingsStub,
      delivery,
      notifications as never,
      cashRegister as never,
      { generateForOrder: async () => ({}), cancelForOrder: async () => undefined } as never,
      config,
      { notifyConfirmed: async () => undefined } as never,
      new PaymentOptionsService(db, settingsStub, config),
    );
    payments = new PaymentAttemptsService(db, notifications as never, cashRegister as never, { notifyConfirmed: async () => undefined } as never);
    billing = new BillingService(db, config, bank as never, notifications as never);

    const category = await db.insertInto('categories').values({ name: `e2e-billing-cat-${RUN}` }).returning('id').executeTakeFirstOrThrow();
    categoryIds.push(category.id);
    const product = await db.insertInto('products').values({ code: `e2e-billing-${RUN}`, name: 'Producto e2e', category_id: category.id, price: '20.00' }).returning('id').executeTakeFirstOrThrow();
    productIds.push(product.id);
    productId = product.id;
  });

  beforeEach(async () => {
    // Cada prueba parte sin pedidos abiertos de las anteriores: cuentan como comisión comprometida y ensuciarían el bloqueo.
    if (customerIds.length) {
      await db.updateTable('orders').set({ status: 'cancelled' }).where('customer_id', 'in', customerIds).where('payment_status', '=', 'unpaid').execute();
    }
    billingCfg = { commissionPercent: 3, overdraftLimit: 10, lowBalanceThreshold: 10, topupMinAmount: 10 };
    bankStatus = 0;
    sent = [];
  });

  afterAll(async () => {
    const orderIds = customerIds.length
      ? (await db.selectFrom('orders').select('id').where('customer_id', 'in', customerIds).execute()).map((o) => o.id)
      : [];
    if (orderIds.length) {
      await db.deleteFrom('balance_ledger').where('order_id', 'in', orderIds).execute();
      await db.deleteFrom('bank_qr_charges').where('order_id', 'in', orderIds).execute();
      await db.deleteFrom('payment_attempts').where('order_id', 'in', orderIds).execute();
    }
    if (topupIds.length) await db.deleteFrom('balance_ledger').where('topup_id', 'in', topupIds).execute();
    if (adjustmentIds.length) await db.deleteFrom('balance_ledger').where('id', 'in', adjustmentIds).execute();
    if (topupIds.length) await db.deleteFrom('balance_topups').where('id', 'in', topupIds).execute();
    if (orderIds.length) await db.deleteFrom('orders').where('id', 'in', orderIds).execute();
    if (customerIds.length) await db.deleteFrom('customers').where('id', 'in', customerIds).execute();
    await db.deleteFrom('idempotency_keys').where('idempotency_key', 'like', `e2e-billing-${RUN}-%`).execute();
    if (productIds.length) await db.deleteFrom('products').where('id', 'in', productIds).execute();
    if (categoryIds.length) await db.deleteFrom('categories').where('id', 'in', categoryIds).execute();
    if (seededSession) await db.deleteFrom('cash_register_sessions').where('id', '=', sessionId).execute();
    await db.updateTable('billing_state').set({ low_balance_notified: false }).execute();
    await db.destroy();
  });

  describe('comisión congelada al crear el pedido', () => {
    it('un pedido del agente por QR guarda el porcentaje y el monto (3 % de 60 = 1.80)', async () => {
      await setBalance(100);
      const row = await orderRow(await agentOrder(3));

      expect(Number(row.agent_commission_percent)).toBe(3);
      expect(Number(row.agent_commission_amount)).toBe(1.8);
    });

    it('el POS no paga comisión', async () => {
      const row = await orderRow(await agentOrder(3, 'pos', 'qr'));

      expect(row.agent_commission_amount).toBeNull();
    });

    it('con la variable sin definir (0 %) no se calcula nada', async () => {
      billingCfg = { ...billingCfg, commissionPercent: 0 };
      const row = await orderRow(await agentOrder(3));

      expect(row.agent_commission_amount).toBeNull();
    });

    it('cambiar el porcentaje después no altera un pedido ya creado', async () => {
      await setBalance(100);
      const id = await agentOrder(3);
      billingCfg = { ...billingCfg, commissionPercent: 50 };

      expect(Number((await orderRow(id)).agent_commission_amount)).toBe(1.8);
    });
  });

  describe('se descuenta solo cuando el QR queda cobrado', () => {
    it('crear el pedido no mueve el saldo; cobrarlo descuenta la comisión en la misma transacción', async () => {
      await setBalance(100);
      const id = await agentOrder(3);
      expect(await getBalance(db)).toBe(100);

      const result = await payOrder(id);

      expect(result.won).toBe(true);
      expect((await orderRow(id)).payment_status).toBe('paid');
      expect(await getBalance(db)).toBe(98.2);
    });

    it('cobrarlo dos veces no descuenta dos veces', async () => {
      await setBalance(100);
      const id = await agentOrder(3);
      await payOrder(id);

      expect(await chargeCommission(db, id)).toBe(false);
      expect(await getBalance(db)).toBe(98.2);
    });

    it('un pedido rechazado no descuenta nada', async () => {
      await setBalance(100);
      const id = await agentOrder(3);
      const attempt = await db.insertInto('payment_attempts').values({ order_id: id, customer_id: null, opened_as: 'normal' }).returning('id').executeTakeFirstOrThrow();

      await payments.decide(attempt.id, 'rejected');

      expect(await getBalance(db)).toBe(100);
    });

    it('un pedido sin comisión (POS) al cobrarse no toca el saldo', async () => {
      await setBalance(100);
      const id = await agentOrder(3, 'pos', 'qr');

      await payOrder(id);

      expect(await getBalance(db)).toBe(100);
    });
  });

  describe('reverso al cancelar un pedido cobrado', () => {
    it('devuelve la comisión una sola vez', async () => {
      await setBalance(100);
      const id = await agentOrder(3);
      await payOrder(id);
      expect(await getBalance(db)).toBe(98.2);

      await orders.updateStatus(id, 'cancelled', 'e2e');

      expect(await getBalance(db)).toBe(100);
      expect(await reverseCommission(db, id)).toBe(false);
      expect(await getBalance(db)).toBe(100);
    });

    it('cancelar un pedido que nunca se cobró no devuelve nada', async () => {
      await setBalance(100);
      const id = await agentOrder(3);

      await orders.updateStatus(id, 'cancelled', 'e2e');

      expect(await getBalance(db)).toBe(100);
    });
  });

  describe('bloqueo por saldo', () => {
    it('cuenta los pedidos abiertos sin cobrar: el segundo ya no entra', async () => {
      await setBalance(0);
      billingCfg = { ...billingCfg, overdraftLimit: 10 };
      // Bs 100 de productos = Bs 3 de comisión: con -10 de tope caben tres pedidos abiertos (3+3+3 = 9) y el cuarto no.
      const ids = [await agentOrder(5), await agentOrder(5), await agentOrder(5)];
      expect((await getAvailable(db)).reserved).toBeGreaterThanOrEqual(9);

      await expect(agentOrder(5)).rejects.toMatchObject({ code: 'agent_service_suspended' });
      expect(ids).toHaveLength(3);
    });

    it('cobrar un pedido ya hecho NUNCA se bloquea aunque el saldo pase del límite', async () => {
      await setBalance(0);
      const id = await agentOrder(5);
      // El saldo cae muy por debajo del límite antes de que el cliente pague.
      await setBalance(-50);

      const result = await payOrder(id);

      expect(result.won).toBe(true);
      expect((await orderRow(id)).payment_status).toBe('paid');
      expect(await getBalance(db)).toBe(-53);
    });

    it('con saldo de sobra no bloquea, y una recarga lo reabre', async () => {
      await setBalance(-9);
      await expect(agentOrder(5)).rejects.toMatchObject({ code: 'agent_service_suspended' });

      await setBalance(50);

      await expect(agentOrder(5)).resolves.toBeDefined();
    });

    it('el límite de sobregiro sale de la variable', async () => {
      await setBalance(-5);
      billingCfg = { ...billingCfg, overdraftLimit: 100 };

      await expect(agentOrder(5)).resolves.toBeDefined();
    });

    it('un pedido del POS nunca se bloquea por saldo', async () => {
      await setBalance(-1000);

      await expect(agentOrder(5, 'pos', 'qr')).resolves.toBeDefined();
    });

    it('un reintento idempotente de un pedido ya creado no es bloqueado', async () => {
      await setBalance(100);
      const customerId = await newCustomer();
      const dto = { customerId, channel: 'whatsapp', customerName: 'Ana', deliveryType: 'pickup', paymentMethod: 'qr', items: [{ productId, quantity: 3 }] } as never;
      const first = await orders.create(dto, key('retry'), 'whatsapp-gateway');
      await setBalance(-1000);

      const again = await orders.create(dto, key('retry'), 'whatsapp-gateway');

      expect((again.body as { id: string }).id).toBe((first.body as { id: string }).id);
    });
  });

  describe('assertAgentCanOrder', () => {
    it('rechaza cuando lo disponible menos la comisión queda bajo el límite, y acepta justo en el límite', async () => {
      await setBalance(0);
      const cfg = { ...billingCfg, overdraftLimit: 10 };
      const { reserved } = await getAvailable(db);

      await expect(assertAgentCanOrder(db, cfg, 10 - reserved)).resolves.toBeUndefined();
      await expect(assertAgentCanOrder(db, cfg, 10.01 - reserved)).rejects.toMatchObject({ code: 'agent_service_suspended' });
    });
  });

  describe('recargas de saldo', () => {
    it('una recarga confirmada suma una sola vez, aunque el cron corra de nuevo', async () => {
      await setBalance(0);
      const topup = await billing.createTopup(25, 'e2e');
      topupIds.push(topup.id);
      expect(topup.status).toBe('pending');
      expect(await getBalance(db)).toBe(0);

      bankStatus = 1;
      await billing.pollPendingTopups();
      await billing.pollPendingTopups();

      expect((await billing.getTopup(topup.id)).status).toBe('confirmed');
      expect(await getBalance(db)).toBe(25);
    });

    it('mientras el banco diga pendiente no suma nada', async () => {
      await setBalance(0);
      const topup = await billing.createTopup(25, 'e2e');
      topupIds.push(topup.id);

      await billing.pollPendingTopups();

      expect((await billing.getTopup(topup.id)).status).toBe('pending');
      expect(await getBalance(db)).toBe(0);
    });

    it('un QR anulado por el banco cierra la recarga sin sumar', async () => {
      await setBalance(0);
      const topup = await billing.createTopup(25, 'e2e');
      topupIds.push(topup.id);

      bankStatus = 9;
      await billing.pollPendingTopups();

      expect((await billing.getTopup(topup.id)).status).toBe('cancelled');
      expect(await getBalance(db)).toBe(0);
    });

    it('bajo el mínimo se rechaza antes de pedirle nada al banco', async () => {
      await expect(billing.createTopup(9.99, 'e2e')).rejects.toMatchObject({ code: 'topup_below_minimum' });
    });

    it('el mínimo sale de la variable', async () => {
      billingCfg = { ...billingCfg, topupMinAmount: 50 };

      await expect(billing.createTopup(49, 'e2e')).rejects.toMatchObject({ code: 'topup_below_minimum' });
    });
  });

  describe('aviso de saldo bajo', () => {
    it('avisa una sola vez al bajar del umbral y se rearma al volver a subir', async () => {
      await db.updateTable('billing_state').set({ low_balance_notified: false }).execute();
      await setBalance(50);
      await billing.checkLowBalance();
      expect(sent.filter((j) => j.kind === 'billing_low_balance')).toHaveLength(0);

      await setBalance(10);
      await billing.checkLowBalance();
      await billing.checkLowBalance();
      expect(sent.filter((j) => j.kind === 'billing_low_balance')).toHaveLength(1);

      await setBalance(50);
      await billing.checkLowBalance();
      await setBalance(5);
      await billing.checkLowBalance();
      expect(sent.filter((j) => j.kind === 'billing_low_balance')).toHaveLength(2);
    });

    it('con la comisión apagada no avisa nada', async () => {
      await db.updateTable('billing_state').set({ low_balance_notified: false }).execute();
      billingCfg = { ...billingCfg, commissionPercent: 0 };
      await setBalance(0);

      await billing.checkLowBalance();

      expect(sent).toHaveLength(0);
    });
  });

  describe('resumen para el POS', () => {
    it('lowBalance y suspended reflejan el saldo y lo comprometido', async () => {
      await setBalance(8);
      let summary = await billing.getSummary();
      expect(summary).toMatchObject({ enabled: true, lowBalance: true, suspended: false, topupConfigured: true });

      await setBalance(-10);
      summary = await billing.getSummary();
      expect(summary.suspended).toBe(true);
    });
  });
});
