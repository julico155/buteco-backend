import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { AgentLocationsService } from '../src/agent-locations/agent-locations.service';
import { AppConfig } from '../src/config/configuration';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import { DomainException } from '../src/common/exceptions/domain-exception';
import { Database } from '../src/database/types';
import { DeliveryService } from '../src/delivery/delivery.service';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentOptionsService } from '../src/payment-options/payment-options.service';
import { createTestDb, describeIfDb } from './utils/test-db';

/**
 * Ubicación de un pedido por teléfono (POST /internal/agent/locations/attach),
 * protección de POST /orders/:id/location y cotización sin pedido
 * (POST /delivery/quotes). Requiere Postgres real con migraciones aplicadas:
 *   DATABASE_URL=... npm run test:e2e
 *
 * Cada corrida crea sus propios clientes/pedidos con prefijo único y los borra
 * al final; no toca configuración, caja ni contadores. Tarifa, distancia y
 * ajustes van con stubs para que el resultado no dependa de la configuración
 * real del local.
 */
describeIfDb('Ubicación de pedidos y cotización sin pedido (integración)', () => {
  const RUN = String(Date.now());
  const key = (suffix: string) => `e2e-loc-${RUN}-${suffix}`;
  const A = { latitude: -17.78, longitude: -63.18 };
  const B = { latitude: -17.77, longitude: -63.18 }; // ~1,1 km de A
  const A_NEARBY = { latitude: -17.78002, longitude: -63.18 }; // ~2 m de A

  const settings = {
    restaurant_latitude: -17.8,
    restaurant_longitude: -63.2,
    rain_surcharge_enabled: false,
    rain_surcharge_amount: '3.00',
  };
  let stubMeters = 1000;
  const distance = { metersBetween: async () => ({ meters: stubMeters, source: 'straight_line' as const }) };
  const tariff = {
    feeForMeters: async (meters: number) =>
      meters > 5000
        ? ({ ok: false, reason: 'manual_quote' } as const)
        : ({ ok: true, amount: 15, bandIndex: 1 } as const),
    maxAutomaticMeters: async () => 5000,
  };

  let db: Kysely<Database>;
  let delivery: DeliveryService;
  let orders: OrdersService;
  let agent: AgentLocationsService;
  const customerIds: string[] = [];
  let seq = 0;

  const newPhone = () => `+59199${RUN.slice(-6)}${String(++seq).padStart(2, '0')}`;

  async function newCustomer() {
    const phone = newPhone();
    const row = await db
      .insertInto('customers')
      .values({ phone, name: 'e2e-loc', email: null })
      .returning(['id', 'phone'])
      .executeTakeFirstOrThrow();
    customerIds.push(row.id);
    return { id: row.id, phone: row.phone as string, waId: (row.phone as string).slice(1) };
  }

  async function newOrder(
    customerId: string,
    opts: {
      status?: 'awaiting_location' | 'cancelled';
      quote?: 'pending' | 'failed' | 'pending_manual';
      coords?: { latitude: number; longitude: number };
      minutesOld?: number;
    } = {},
  ) {
    const row = await db
      .insertInto('orders')
      .values({
        order_number: `ORD-E2E-${RUN}-${++seq}`,
        customer_id: customerId,
        channel: 'whatsapp',
        customer_name: 'e2e-loc',
        delivery_type: 'delivery',
        payment_method: 'qr',
        status: opts.status ?? 'awaiting_location',
        subtotal_amount: '50.00',
        total_amount: '50.00',
        delivery_pricing: 'dynamic',
        delivery_quote_status: opts.quote ?? 'pending',
        delivery_latitude: opts.coords?.latitude ?? null,
        delivery_longitude: opts.coords?.longitude ?? null,
        created_at: new Date(Date.now() - (opts.minutesOld ?? 0) * 60_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  const readOrder = (id: string) =>
    db
      .selectFrom('orders')
      .select(['status', 'delivery_quote_status', 'delivery_latitude', 'delivery_longitude', 'total_amount'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  const attach = (waId: string, coords: { latitude: number; longitude: number }, wamid: string) =>
    agent.attach(
      { customerPhone: waId, latitude: coords.latitude, longitude: coords.longitude, sourceMessageId: key(wamid) },
      'whatsapp-gateway',
    );

  beforeAll(() => {
    db = createTestDb();
    const settingsStub = { getRow: async () => settings } as never;
    delivery = new DeliveryService(db, tariff as never, distance as never, settingsStub);
    orders = new OrdersService(
      db,
      {} as never,
      settingsStub,
      delivery,
      {} as never,
      {} as never,
      {} as never,
      { get: () => 10 } as unknown as ConfigService<AppConfig, true>,
      { notifyConfirmed: async () => undefined } as never,
      new PaymentOptionsService(db, {} as never, {} as never),
    );
    agent = new AgentLocationsService(
      db,
      new IdempotencyService(db),
      orders,
      { get: () => 10 } as unknown as ConfigService<AppConfig, true>,
    );
  });

  afterAll(async () => {
    if (customerIds.length > 0) {
      await db.deleteFrom('orders').where('customer_id', 'in', customerIds).execute();
      await db.deleteFrom('customers').where('id', 'in', customerIds).execute();
    }
    await db.deleteFrom('idempotency_keys').where('idempotency_key', 'like', `e2e-loc-${RUN}%`).execute();
    await db.deleteFrom('delivery_quote_requests').where('idempotency_key', 'like', `e2e-loc-${RUN}%`).execute();
    await db.destroy();
  });

  describe('POST /delivery/quotes (sin pedido)', () => {
    it('normal: tarifa sin recargo, total = tarifa', async () => {
      stubMeters = 1000;
      settings.rain_surcharge_enabled = false;
      const res = await delivery.quoteStandalone({ ...A }, key('q-normal'));
      expect(res).toMatchObject({ status: 'quoted', distanceMeters: 1000, feeAmount: 15, surchargeAmount: 0, totalAmount: 15 });
    });

    it('con lluvia: suma el recargo y devuelve el monto final; la repetición devuelve lo mismo aunque el recargo cambie', async () => {
      stubMeters = 4200;
      settings.rain_surcharge_enabled = true;
      const first = await delivery.quoteStandalone({ ...A }, key('q-lluvia'));
      expect(first).toMatchObject({ status: 'quoted', distanceMeters: 4200, feeAmount: 15, surchargeAmount: 3, totalAmount: 18 });

      settings.rain_surcharge_enabled = false;
      const replay = await delivery.quoteStandalone({ ...A }, key('q-lluvia'));
      expect(replay).toEqual(first);
    });

    it('fuera de rango: manual_quote sin montos y sin crear ningún pedido', async () => {
      stubMeters = 9000;
      settings.rain_surcharge_enabled = true;
      const before = await db.selectFrom('orders').select(db.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
      const res = await delivery.quoteStandalone({ ...A }, key('q-fuera'));
      expect(res).toMatchObject({ status: 'manual_quote', distanceMeters: 9000, feeAmount: null, surchargeAmount: null, totalAmount: null });
      const after = await db.selectFrom('orders').select(db.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
      expect(after.n).toBe(before.n);
      settings.rain_surcharge_enabled = false;
      stubMeters = 1000;
    });
  });

  describe('POST /internal/agent/locations/attach', () => {
    it('no_order: teléfono desconocido y cliente sin pedidos', async () => {
      expect(await attach('59100000000', A, 'n-1')).toEqual({ result: 'no_order' });
      const c = await newCustomer();
      expect(await attach(c.waId, A, 'n-2')).toEqual({ result: 'no_order' });
    });

    it('no_order después de que el pedido expiró: vencido o cancelado no se revive ni se le asocia el pin', async () => {
      const c = await newCustomer();
      const cancelled = await newOrder(c.id, { status: 'cancelled' });
      const stale = await newOrder(c.id, { minutesOld: 11 }); // sigue awaiting_location hasta que corre el cron
      expect(await attach(c.waId, A, 'exp-1')).toEqual({ result: 'no_order' });
      for (const id of [cancelled, stale]) {
        const o = await readOrder(id);
        expect(o.delivery_latitude).toBeNull();
        expect(o.status).not.toBe('confirmed');
      }
    });

    it('ambiguous_order: 2 pedidos esperando ubicación, no elige ninguno y no guarda nada', async () => {
      const c = await newCustomer();
      const o1 = await newOrder(c.id);
      const o2 = await newOrder(c.id);
      const res = await attach(c.waId, A, 'amb-1');
      expect(res.result).toBe('ambiguous_order');
      if (res.result !== 'ambiguous_order') throw new Error('unreachable');
      expect(res.orders.map((o) => o.id).sort()).toEqual([o1, o2].sort());
      expect(res.orders[0]).toEqual({ id: expect.any(String), orderNumber: expect.any(String), totalAmount: 50 });
      for (const id of [o1, o2]) expect((await readOrder(id)).delivery_latitude).toBeNull();
    });

    it('attached: guarda la ubicación, cotiza y el teléfono sin + encuentra al cliente', async () => {
      stubMeters = 1000;
      const c = await newCustomer();
      const id = await newOrder(c.id);
      const res = await attach(c.waId, A, 'att-1');
      expect(res).toMatchObject({ result: 'attached', orderId: id });
      const o = await readOrder(id);
      expect(o).toMatchObject({ status: 'confirmed', delivery_quote_status: 'quoted', delivery_latitude: A.latitude, delivery_longitude: A.longitude });
      expect(Number(o.total_amount)).toBe(65);
    });

    it('already_attached: pedido esperando ubicación que ya la tiene y la misma llega otra vez (~2 m) no cambia nada', async () => {
      const c = await newCustomer();
      const id = await newOrder(c.id, { quote: 'pending_manual', coords: A });
      const res = await attach(c.waId, A_NEARBY, 'aa-1');
      expect(res).toMatchObject({ result: 'already_attached', orderId: id });
      expect(await readOrder(id)).toMatchObject({ delivery_quote_status: 'pending_manual', delivery_latitude: A.latitude, delivery_longitude: A.longitude });
    });

    it('no_order: pedido anterior confirmed/quoted y NINGUNO esperando ubicación, misma ubicación o distinta; el anterior no se toca', async () => {
      const c = await newCustomer();
      const id = await newOrder(c.id);
      await attach(c.waId, A, 'prev-1'); // queda confirmed / quoted
      const before = await readOrder(id);
      expect(before).toMatchObject({ status: 'confirmed', delivery_quote_status: 'quoted' });

      expect(await attach(c.waId, A, 'prev-2')).toEqual({ result: 'no_order' });
      expect(await attach(c.waId, A_NEARBY, 'prev-3')).toEqual({ result: 'no_order' });
      expect(await attach(c.waId, B, 'prev-4')).toEqual({ result: 'no_order' });
      expect(await readOrder(id)).toEqual(before);
    });

    it('ubicación distinta antes de cotizar (pending / failed): reemplaza y cotiza', async () => {
      const c = await newCustomer();
      const pending = await newOrder(c.id, { quote: 'pending', coords: A });
      expect(await attach(c.waId, B, 'rep-1')).toMatchObject({ result: 'attached', orderId: pending });
      expect(await readOrder(pending)).toMatchObject({ delivery_quote_status: 'quoted', delivery_latitude: B.latitude });

      const c2 = await newCustomer();
      const failed = await newOrder(c2.id, { quote: 'failed', coords: A });
      expect(await attach(c2.waId, B, 'rep-2')).toMatchObject({ result: 'attached', orderId: failed });
      expect(await readOrder(failed)).toMatchObject({ delivery_quote_status: 'quoted', delivery_latitude: B.latitude });
    });

    it('location_conflict: pedido esperando ubicación en pending_manual y llega una distinta; no modifica las coordenadas', async () => {
      const c = await newCustomer();
      const pm = await newOrder(c.id, { quote: 'pending_manual', coords: A });
      const res = await attach(c.waId, B, 'con-1');
      expect(res.result).toBe('location_conflict');
      expect(await readOrder(pm)).toMatchObject({ delivery_quote_status: 'pending_manual', delivery_latitude: A.latitude, delivery_longitude: A.longitude });
    });

    it('dedupe por sourceMessageId: el reintento devuelve la misma respuesta sin volver a ejecutar', async () => {
      const c = await newCustomer();
      await newOrder(c.id);
      const first = await attach(c.waId, A, 'dd-1');
      const retry = await attach(c.waId, A, 'dd-1'); // si re-ejecutara daría already_attached
      expect(first.result).toBe('attached');
      expect(retry).toEqual(first);
      const rows = await db.selectFrom('idempotency_keys').select('id').where('idempotency_key', '=', key('dd-1')).execute();
      expect(rows).toHaveLength(1);

      await expect(attach(c.waId, B, 'dd-1')).rejects.toMatchObject({ code: 'idempotency_key_reused' });
    });
  });

  describe('POST /orders/:id/location (protección)', () => {
    it('rechaza con location_conflict una ubicación distinta si ya fue cotizado, sin tocar lat/lng', async () => {
      const c = await newCustomer();
      const id = await newOrder(c.id);
      await orders.attachLocation(id, A);
      expect(await readOrder(id)).toMatchObject({ delivery_quote_status: 'quoted', delivery_latitude: A.latitude });

      const error = await orders.attachLocation(id, B).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe('location_conflict');
      expect(await readOrder(id)).toMatchObject({ delivery_latitude: A.latitude, delivery_longitude: A.longitude });
    });

    it('la misma ubicación es idempotente y una distinta antes de cotizar sí se acepta', async () => {
      const c = await newCustomer();
      const id = await newOrder(c.id);
      await orders.attachLocation(id, A);
      await expect(orders.attachLocation(id, A_NEARBY)).resolves.toMatchObject({ id });

      const c2 = await newCustomer();
      const pending = await newOrder(c2.id, { quote: 'pending', coords: A });
      await orders.attachLocation(pending, B);
      expect(await readOrder(pending)).toMatchObject({ delivery_latitude: B.latitude, delivery_quote_status: 'quoted' });
    });
  });
});
