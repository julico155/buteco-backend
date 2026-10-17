import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { AgentLocationsService } from '../src/agent-locations/agent-locations.service';
import { AppConfig } from '../src/config/configuration';
import { DomainException } from '../src/common/exceptions/domain-exception';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import { Database } from '../src/database/types';
import { DeliveryService } from '../src/delivery/delivery.service';
import { ALL_AVAILABLE } from '../src/operational-settings/availability.fixtures';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentOptionsService } from '../src/payment-options/payment-options.service';
import { createTestDb, describeIfDb } from './utils/test-db';

/**
 * NO se ha ejecutado todavía (M6A solo escribe las pruebas). Pedido de delivery del checkout web CON ubicación, contra
 * Postgres real con migraciones aplicadas (incluida 1700000013000):
 *   DATABASE_URL=... npm run migrate:up
 *   DATABASE_URL=... npm run test:e2e -- web-location
 *
 * Demuestra lo que las pruebas con mocks no pueden: que la ubicación, la cotización y el pedido son UNA transacción, que
 * nunca se emite `location_request`, que los reintentos y las rachas concurrentes con la misma clave no duplican ni cambian
 * la ubicación, y que una cotización fallida no deja nada (ni pedido ni clave). Distancia, tarifa y ajustes van con stubs.
 * NO cubre la ventana fuera de horario (HTTP 202): depende del reloj y de la caja reales; está cubierta con dobles en
 * `late-order-requests.web-location.spec.ts` y `orders.web-location.spec.ts`, y debe probarse a mano en la validación final.
 * Cada corrida usa clientes/productos con prefijo único y los borra; consume contadores de numeración como cualquier pedido.
 */
describeIfDb('Pedido web de delivery con ubicación (integración)', () => {
  const RUN = String(Date.now());
  const key = (suffix: string) => `e2e-webloc-${RUN}-${suffix}`;
  const A = { latitude: -17.78, longitude: -63.18 };
  const B = { latitude: -17.7, longitude: -63.1 };

  let settings: Record<string, unknown>;
  let stubMeters = 1000;
  const distance = { metersBetween: async () => ({ meters: stubMeters, source: 'straight_line' as const }) };
  const tariff = {
    feeForMeters: async (meters: number) => (meters > 5000 ? ({ ok: false, reason: 'manual_quote' } as const) : ({ ok: true, amount: 15, bandIndex: 1 } as const)),
    maxAutomaticMeters: async () => 5000,
  };

  let db: Kysely<Database>;
  let orders: OrdersService;
  let agent: AgentLocationsService;
  let sent: Array<{ channel: string; kind: string; targetRef: string }>;
  const customerIds: string[] = [];
  const categoryIds: string[] = [];
  const productIds: string[] = [];
  let seededSessionId: string | null = null;
  let seq = 0;
  let productId: string;

  const notifications = {
    notifyNow: async (job: { channel: string; kind: string; targetRef: string }) => {
      sent.push({ channel: job.channel, kind: job.kind, targetRef: job.targetRef });
    },
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

  async function newCustomer() {
    const phone = `+59199${RUN.slice(-6)}${String(++seq).padStart(2, '0')}`;
    const row = await db.insertInto('customers').values({ phone, name: 'e2e-webloc', email: null }).returning(['id', 'phone']).executeTakeFirstOrThrow();
    customerIds.push(row.id);
    return { id: row.id, phone: row.phone as string };
  }

  const dto = (customerId: string, extra: Record<string, unknown> = {}) => ({
    customerId,
    channel: 'web' as const,
    customerName: 'Ana',
    deliveryType: 'delivery' as const,
    paymentMethod: 'cash' as const,
    items: [{ productId, quantity: 3 }],
    ...extra,
  });

  const readOrders = (customerId: string) =>
    db
      .selectFrom('orders')
      .select(['id', 'status', 'delivery_quote_status', 'delivery_latitude', 'delivery_longitude', 'subtotal_amount', 'total_amount', 'delivery_base_amount', 'delivery_surcharge_amount'])
      .where('customer_id', '=', customerId)
      .execute();

  beforeAll(async () => {
    db = createTestDb();
    settings = { business_opens_hour: 0, business_closes_hour: 23, ...ALL_AVAILABLE, restaurant_latitude: -17.8, restaurant_longitude: -63.2, rain_surcharge_enabled: false, rain_surcharge_amount: '3.00' };
    const settingsStub = { getRow: async () => settings } as never;
    const delivery = new DeliveryService(db, tariff as never, distance as never, settingsStub);
    const config = { get: (name: string) => (name === 'aiTestPhones' ? [] : 10) } as unknown as ConfigService<AppConfig, true>;
    orders = new OrdersService(
      db,
      new IdempotencyService(db),
      settingsStub,
      delivery,
      notifications as never,
      { isOpen: async () => true } as never,
      {} as never,
      config,
      { notifyConfirmed: async () => undefined } as never,
      new PaymentOptionsService(db, {} as never, {} as never),
    );
    agent = new AgentLocationsService(db, new IdempotencyService(db), orders, config);

    const category = await db.insertInto('categories').values({ name: `e2e-webloc-cat-${RUN}` }).returning('id').executeTakeFirstOrThrow();
    categoryIds.push(category.id);
    const product = await db.insertInto('products').values({ code: `e2e-webloc-${RUN}`, name: 'Producto e2e', category_id: category.id, price: '20.00' }).returning('id').executeTakeFirstOrThrow();
    productIds.push(product.id);
    productId = product.id;

    const existingOpen = await db.selectFrom('cash_register_sessions').select('id').where('status', '=', 'open').executeTakeFirst();
    if (!existingOpen) {
      const seeded = await db.insertInto('cash_register_sessions').values({ opened_by: 'web-location.e2e-spec', opening_amount: '0' }).returning('id').executeTakeFirstOrThrow();
      seededSessionId = seeded.id;
    }
  });

  beforeEach(() => {
    sent = [];
    stubMeters = 1000;
    settings.restaurant_latitude = -17.8;
    settings.restaurant_longitude = -63.2;
  });

  afterAll(async () => {
    if (customerIds.length > 0) {
      await db.deleteFrom('orders').where('customer_id', 'in', customerIds).execute();
      await db.deleteFrom('customers').where('id', 'in', customerIds).execute();
    }
    await db.deleteFrom('idempotency_keys').where('idempotency_key', 'like', `e2e-webloc-${RUN}-%`).execute();
    if (productIds.length > 0) await db.deleteFrom('products').where('id', 'in', productIds).execute();
    if (categoryIds.length > 0) await db.deleteFrom('categories').where('id', 'in', categoryIds).execute();
    if (seededSessionId) await db.deleteFrom('cash_register_sessions').where('id', '=', seededSessionId).execute();
    await db.destroy();
  });

  it('1. nace ubicado, cotizado y confirmado en UNA creación: tarifa de Central sobre el subtotal real, sin location_request', async () => {
    const customer = await newCustomer();

    const result = await orders.create(dto(customer.id, { deliveryLocation: A }) as never, key('1'), 'web');
    await flush();

    expect(result.httpStatus).toBe(201);
    const [row] = await readOrders(customer.id);
    expect(row).toMatchObject({ status: 'confirmed', delivery_quote_status: 'quoted', delivery_latitude: A.latitude, delivery_longitude: A.longitude });
    expect(Number(row.subtotal_amount)).toBe(60);
    expect(Number(row.delivery_base_amount)).toBe(15);
    expect(Number(row.total_amount)).toBe(75);
    expect(sent.map((job) => job.kind)).toEqual(['order_received', 'cash_on_delivery_confirmation']);
  });

  it('2. el recargo por lluvia se suma UNA vez', async () => {
    settings.rain_surcharge_enabled = true;
    const customer = await newCustomer();

    await orders.create(dto(customer.id, { deliveryLocation: A }) as never, key('2'), 'web');
    settings.rain_surcharge_enabled = false;

    const [row] = await readOrders(customer.id);
    expect(Number(row.delivery_surcharge_amount)).toBe(3);
    expect(Number(row.total_amount)).toBe(60 + 15 + 3);
  });

  it('3. por encima del techo automático: pending_manual con coordenadas, total = subtotal (no Bs 0 de envío) y alerta al personal', async () => {
    stubMeters = 9000;
    const customer = await newCustomer();

    await orders.create(dto(customer.id, { deliveryLocation: A }) as never, key('3'), 'web');
    await flush();

    const [row] = await readOrders(customer.id);
    expect(row).toMatchObject({ status: 'awaiting_location', delivery_quote_status: 'pending_manual', delivery_latitude: A.latitude });
    expect(Number(row.total_amount)).toBe(60);
    expect(sent.map((job) => job.kind)).toEqual(['order_received', 'manual_quote_alert']);
  });

  it('4. cotización imposible (sin origen del local): error y NO queda ni pedido ni clave de idempotencia', async () => {
    settings.restaurant_latitude = null;
    const customer = await newCustomer();

    await expect(orders.create(dto(customer.id, { deliveryLocation: A }) as never, key('4'), 'web')).rejects.toBeInstanceOf(DomainException);

    expect(await readOrders(customer.id)).toHaveLength(0);
    const keys = await db.selectFrom('idempotency_keys').select('id').where('idempotency_key', '=', key('4')).execute();
    expect(keys).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('5. un pedido web SIN ubicación sigue como siempre: awaiting_location y un location_request', async () => {
    const customer = await newCustomer();

    await orders.create(dto(customer.id) as never, key('5'), 'web');
    await flush();

    const [row] = await readOrders(customer.id);
    expect(row).toMatchObject({ status: 'awaiting_location', delivery_quote_status: 'pending', delivery_latitude: null });
    expect(sent.map((job) => job.kind)).toEqual(['location_request']);
  });

  it('6. reintento con la MISMA clave y la misma ubicación: 200, el mismo pedido y ningún aviso repetido', async () => {
    const customer = await newCustomer();
    const first = await orders.create(dto(customer.id, { deliveryLocation: A }) as never, key('6'), 'web');
    await flush();
    const sentBefore = sent.length;

    const retry = await orders.create(dto(customer.id, { deliveryLocation: A }) as never, key('6'), 'web');
    await flush();

    expect(retry.httpStatus).toBe(200);
    expect((retry.body as { id: string }).id).toBe((first.body as { id: string }).id);
    expect(await readOrders(customer.id)).toHaveLength(1);
    expect(sent).toHaveLength(sentBefore);
  });

  it('7. la MISMA clave con OTRA ubicación: 409 idempotency_key_reused, y la ubicación del pedido no cambia', async () => {
    const customer = await newCustomer();
    await orders.create(dto(customer.id, { deliveryLocation: A }) as never, key('7'), 'web');

    await expect(orders.create(dto(customer.id, { deliveryLocation: B }) as never, key('7'), 'web')).rejects.toMatchObject({ code: 'idempotency_key_reused' });

    const rows = await readOrders(customer.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delivery_latitude: A.latitude, delivery_longitude: A.longitude });
  });

  it('8. ocho solicitudes simultáneas con la misma clave: un solo pedido, una sola ubicación y ningún location_request', async () => {
    const customer = await newCustomer();

    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => orders.create(dto(customer.id, { deliveryLocation: A }) as never, key('8'), 'web')));
    await flush();

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled') as PromiseFulfilledResult<{ httpStatus: number; body: { id: string } }>[];
    expect(fulfilled.filter((outcome) => outcome.value.httpStatus === 201)).toHaveLength(1);
    expect(new Set(fulfilled.map((outcome) => outcome.value.body.id)).size).toBe(1);
    expect(await readOrders(customer.id)).toHaveLength(1);
    expect(sent.map((job) => job.kind)).not.toContain('location_request');
  });

  it('9. WhatsApp no puede mandar la ubicación al crear: se rechaza y no queda nada', async () => {
    const customer = await newCustomer();

    await expect(orders.create({ ...dto(customer.id, { deliveryLocation: A }), channel: 'whatsapp' } as never, key('9'), 'whatsapp-gateway')).rejects.toMatchObject({ code: 'delivery_location_not_supported' });

    expect(await readOrders(customer.id)).toHaveLength(0);
  });

  it('10. un pin posterior por WhatsApp NO toca un pedido web ya ubicado (no hay segunda cotización)', async () => {
    const customer = await newCustomer();
    await orders.create(dto(customer.id, { deliveryLocation: A }) as never, key('10'), 'web');

    const outcome = await agent.attach({ customerPhone: customer.phone.slice(1), latitude: B.latitude, longitude: B.longitude, sourceMessageId: key('10-pin') }, 'whatsapp-gateway');

    expect(outcome).toEqual({ result: 'no_order' });
    const [row] = await readOrders(customer.id);
    expect(row).toMatchObject({ status: 'confirmed', delivery_latitude: A.latitude, delivery_longitude: A.longitude });
  });

  it('11. y un pin DISTINTO sobre un pedido web en pending_manual es location_conflict, sin modificar nada', async () => {
    stubMeters = 9000;
    const customer = await newCustomer();
    await orders.create(dto(customer.id, { deliveryLocation: A }) as never, key('11'), 'web');

    const outcome = await agent.attach({ customerPhone: customer.phone.slice(1), latitude: B.latitude, longitude: B.longitude, sourceMessageId: key('11-pin') }, 'whatsapp-gateway');

    expect(outcome.result).toBe('location_conflict');
    const [row] = await readOrders(customer.id);
    expect(row).toMatchObject({ delivery_latitude: A.latitude, delivery_longitude: A.longitude, delivery_quote_status: 'pending_manual' });
  });
});
