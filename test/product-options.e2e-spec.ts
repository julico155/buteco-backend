import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { AppConfig } from '../src/config/configuration';
import { DomainException } from '../src/common/exceptions/domain-exception';
import { localWeekdayAndMinute } from '../src/common/time/weekly-schedule';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import { Database } from '../src/database/types';
import { ALL_AVAILABLE } from '../src/operational-settings/availability.fixtures';
import { OrderReplacementService } from '../src/order-replacement/order-replacement.service';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentOptionsService } from '../src/payment-options/payment-options.service';
import { TableAccountsService } from '../src/tables/table-accounts.service';
import { ProductsService } from '../src/products/products.service';
import { PromotionsService } from '../src/promotions/promotions.service';
import { createTestDb, describeIfDb } from './utils/test-db';

/**
 * Opciones de producto (carnes de una tabla, tamaño) y disponibilidad por día, contra Postgres real con las migraciones
 * aplicadas (incluida 1700000016000):
 *   DATABASE_URL=... npm run migrate:up
 *   DATABASE_URL=... npm run test:e2e -- product-options
 * Cada corrida usa productos/clientes con prefijo único y los borra. Los pedidos entran por el canal `pos` con bypass de horario
 * para no depender del reloj; el reloj SÍ importa en la disponibilidad por día, que se prueba contra el día real de La Paz.
 */
describeIfDb('Opciones de producto y disponibilidad por día (integración)', () => {
  const RUN = String(Date.now());
  const key = (suffix: string) => `e2e-opts-${RUN}-${suffix}`;

  let db: Kysely<Database>;
  let products: ProductsService;
  let orders: OrdersService;
  let replacement: OrderReplacementService;
  let accounts: TableAccountsService;
  let floorId: string | null = null;
  const customerIds: string[] = [];
  const categoryIds: string[] = [];
  const productIds: string[] = [];
  const promotionIds: string[] = [];
  let seededSessionId: string | null = null;
  let zeusId: string;
  let tablitaId: string;
  let sopaId: string;
  let seq = 0;

  const CARNES = ['pollo', 'chancho', 'costilla-res'].map((code) => ({ code, name: code }));
  const zeusGroups = () => ({
    groups: [
      { code: 'carne-1', name: 'Carne 1', options: CARNES },
      { code: 'carne-2', name: 'Carne 2', options: CARNES },
    ],
  });

  async function newCustomer(channelPhonePrefix = '99') {
    const phone = `+591${channelPhonePrefix}${RUN.slice(-6)}${String(++seq).padStart(2, '0')}`;
    const row = await db.insertInto('customers').values({ phone, name: 'e2e-opts', email: null }).returning(['id', 'phone']).executeTakeFirstOrThrow();
    customerIds.push(row.id);
    return { id: row.id, phone: row.phone as string };
  }

  async function newProduct(suffix: string, price: string, extra: Record<string, unknown> = {}) {
    const row = await db
      .insertInto('products')
      .values({ code: `e2e-opts-${RUN}-${suffix}`, name: `Producto ${suffix}`, category_id: categoryIds[0], price, ...extra })
      .returning('id')
      .executeTakeFirstOrThrow();
    productIds.push(row.id);
    return row.id;
  }

  const catalog = async (productId: string) => (await products.findMany(true)).find((p) => p.id === productId)!;

  const pickups = (customerId: string, items: unknown[], extra: Record<string, unknown> = {}) => ({
    customerId,
    channel: 'pos' as const,
    customerName: 'Ana',
    deliveryType: 'pickup' as const,
    paymentMethod: 'cash' as const,
    bypassHoursGate: true,
    items,
    ...extra,
  });

  beforeAll(async () => {
    db = createTestDb();
    const settings = { business_opens_hour: 0, business_closes_hour: 23, ...ALL_AVAILABLE };
    const settingsStub = { getRow: async () => settings } as never;
    const idempotency = new IdempotencyService(db);
    const config = {
      get: (name: string) => (name === 'aiTestPhones' ? [] : name === 'baneco' ? { baseUrl: '', username: '', password: '', aesKey: '', account: '' } : name === 'posQrMode' ? 'manual' : 10),
    } as unknown as ConfigService<AppConfig, true>;
    const cashRegister = { isOpen: async () => true } as never;
    products = new ProductsService(db, {} as never);
    orders = new OrdersService(
      db,
      idempotency,
      settingsStub,
      {} as never,
      { notifyNow: async () => undefined } as never,
      cashRegister,
      {} as never,
      config,
      { notifyConfirmed: async () => undefined } as never,
      new PaymentOptionsService(db, settingsStub, config),
    );
    replacement = new OrderReplacementService(db, idempotency, settingsStub, cashRegister, orders);
    accounts = new TableAccountsService(db, orders, idempotency, {} as never, {} as never);

    const category = await db.insertInto('categories').values({ name: `e2e-opts-cat-${RUN}` }).returning('id').executeTakeFirstOrThrow();
    categoryIds.push(category.id);
    zeusId = await newProduct('zeus', '175.00', { serves_label: '2 a 3 personas', prep_minutes: 40 });
    tablitaId = await newProduct('tablita', '50.00');
    sopaId = await newProduct('sopa', '15.00');

    const existingOpen = await db.selectFrom('cash_register_sessions').select('id').where('status', '=', 'open').executeTakeFirst();
    if (!existingOpen) {
      const seeded = await db.insertInto('cash_register_sessions').values({ opened_by: 'product-options.e2e-spec', opening_amount: '0' }).returning('id').executeTakeFirstOrThrow();
      seededSessionId = seeded.id;
    }
  });

  afterAll(async () => {
    if (customerIds.length > 0) {
      // Los reemplazos enlazan pedidos entre sí: se sueltan antes de borrar.
      await db.updateTable('orders').set({ replaces_order_id: null, replaced_by_order_id: null }).where('customer_id', 'in', customerIds).execute();
      await db.deleteFrom('orders').where('customer_id', 'in', customerIds).execute();
      await db.deleteFrom('customers').where('id', 'in', customerIds).execute();
    }
    await db.deleteFrom('idempotency_keys').where('idempotency_key', 'like', `e2e-opts-${RUN}-%`).execute();
    if (floorId) {
      await db.deleteFrom('orders').where('table_id', 'in', db.selectFrom('tables').select('id').where('floor_id', '=', floorId)).execute();
      await db.deleteFrom('tables').where('floor_id', '=', floorId).execute();
      await db.deleteFrom('floors').where('id', '=', floorId).execute();
    }
    if (promotionIds.length > 0) await db.deleteFrom('promotions').where('id', 'in', promotionIds).execute();
    if (productIds.length > 0) await db.deleteFrom('products').where('id', 'in', productIds).execute();
    if (categoryIds.length > 0) await db.deleteFrom('categories').where('id', 'in', categoryIds).execute();
    if (seededSessionId) await db.deleteFrom('cash_register_sessions').where('id', '=', seededSessionId).execute();
    await db.destroy();
  });

  it('1. PUT option-groups crea grupos y GET /products los devuelve; un producto sin grupos sale con los campos neutros', async () => {
    const saved = await products.replaceOptionGroups(zeusId, zeusGroups());

    expect(saved.optionGroups.map((g) => g.code)).toEqual(['carne-1', 'carne-2']);
    expect(saved.optionGroups[0]).toMatchObject({ minSelect: 1, maxSelect: 1, showInNotice: false });
    expect(saved.optionGroups[0].options.map((o) => [o.code, o.priceDelta, o.isAvailable])).toEqual([
      ['pollo', 0, true],
      ['chancho', 0, true],
      ['costilla-res', 0, true],
    ]);
    expect(saved).toMatchObject({ servesLabel: '2 a 3 personas', prepMinutes: 40, availableWeekdays: null, isAvailableToday: true });

    expect(await catalog(sopaId)).toMatchObject({ optionGroups: [], availableWeekdays: null, isAvailableToday: true, servesLabel: null, prepMinutes: null });
  });

  it('2. reemplazar los grupos CONSERVA los ids por code, aplica cambios y borra lo que ya no viene', async () => {
    const before = await catalog(zeusId);
    const groupId = before.optionGroups[0].id;
    const polloId = before.optionGroups[0].options[0].id;

    const after = await products.replaceOptionGroups(zeusId, {
      groups: [
        {
          code: 'carne-1',
          name: 'Primera carne',
          options: [
            { code: 'pollo', name: 'Pollo frito', priceDelta: 5 },
            { code: 'chancho', name: 'chancho' },
          ],
        },
      ],
    });

    expect(after.optionGroups).toHaveLength(1);
    expect(after.optionGroups[0]).toMatchObject({ id: groupId, name: 'Primera carne' });
    expect(after.optionGroups[0].options.map((o) => o.code)).toEqual(['pollo', 'chancho']);
    expect(after.optionGroups[0].options[0]).toMatchObject({ id: polloId, name: 'Pollo frito', priceDelta: 5 });

    // Se restaura el catálogo del resto de las pruebas.
    const restored = await products.replaceOptionGroups(zeusId, zeusGroups());
    expect(restored.optionGroups[0].id).toBe(groupId);
  });

  it('3. un pedido con carnes guarda el snapshot, congela el precio y GET /orders/:id lo muestra; Central rechaza lo inválido', async () => {
    const zeus = await catalog(zeusId);
    const [g1, g2] = zeus.optionGroups;
    const customer = await newCustomer();
    const selection = [
      { groupId: g1.id, optionId: g1.options[0].id }, // pollo
      { groupId: g2.id, optionId: g2.options[0].id }, // pollo otra vez: se permite repetir
    ];

    const result = await orders.create(pickups(customer.id, [{ productId: zeusId, quantity: 2, selectedOptions: selection }]) as never, key('3'), 'pos');

    expect(result.httpStatus).toBe(201);
    const order = await orders.findById((result.body as { id: string }).id);
    expect(order.subtotalAmount).toBe(350);
    expect(order.items[0]).toMatchObject({ unitPriceSnapshot: 175, subtotal: 350, quantity: 2 });
    expect(order.items[0].selectedOptions?.map((o) => `${o.groupCode}:${o.optionCode}`)).toEqual(['carne-1:pollo', 'carne-2:pollo']);
    expect(order.items[0].selectedOptions?.[0]).not.toHaveProperty('showInNotice');

    const row = await db.selectFrom('order_items').select(['serves_label_snapshot', 'prep_minutes_snapshot']).where('order_id', '=', order.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ serves_label_snapshot: '2 a 3 personas', prep_minutes_snapshot: 40 });

    // Faltan las carnes -> 400; una carne de otro producto -> 400.
    await expect(orders.create(pickups(customer.id, [{ productId: zeusId, quantity: 1 }]) as never, key('3a'), 'pos')).rejects.toMatchObject({ code: 'invalid_option_selection' });
    await expect(
      orders.create(pickups(customer.id, [{ productId: zeusId, quantity: 1, selectedOptions: [{ groupId: g1.id, optionId: g2.options[0].id }, selection[1]] }]) as never, key('3b'), 'pos'),
    ).rejects.toMatchObject({ code: 'invalid_option_selection' });
  });

  it('4. el precio sale de la base: un cambio posterior del catálogo NO altera el pedido ya hecho', async () => {
    await products.replaceOptionGroups(tablitaId, {
      groups: [{ code: 'tamano', name: 'Tamaño', showInNotice: true, options: [{ code: '1-persona', name: '1 persona' }, { code: '2-personas', name: '2 personas', priceDelta: 50 }] }],
    });
    const tablita = await catalog(tablitaId);
    const group = tablita.optionGroups[0];
    const dos = group.options[1];
    const customer = await newCustomer();

    const result = await orders.create(pickups(customer.id, [{ productId: tablitaId, quantity: 1, selectedOptions: [{ groupId: group.id, optionId: dos.id }] }]) as never, key('4'), 'pos');
    const orderId = (result.body as { id: string }).id;
    expect((result.body as { subtotalAmount: number }).subtotalAmount).toBe(100);

    // Sube el delta y se renombra la opción: el pedido viejo conserva su snapshot.
    await products.replaceOptionGroups(tablitaId, {
      groups: [{ code: 'tamano', name: 'Tamaño', showInNotice: true, options: [{ code: '1-persona', name: '1 persona' }, { code: '2-personas', name: 'Para dos', priceDelta: 80 }] }],
    });
    const old = await orders.findById(orderId);
    expect(old.items[0]).toMatchObject({ unitPriceSnapshot: 100, subtotal: 100 });
    expect(old.items[0].selectedOptions?.[0]).toMatchObject({ optionName: '2 personas', priceDelta: 50 });
  });

  it('5. una carne agotada se rechaza con 409 option_unavailable', async () => {
    const zeus = await catalog(zeusId);
    const [g1, g2] = zeus.optionGroups;
    await products.setOptionAvailability(g1.options[2].id, false);
    const customer = await newCustomer();

    await expect(
      orders.create(pickups(customer.id, [{ productId: zeusId, quantity: 1, selectedOptions: [{ groupId: g1.id, optionId: g1.options[2].id }, { groupId: g2.id, optionId: g2.options[0].id }] }]) as never, key('5'), 'pos'),
    ).rejects.toMatchObject({ code: 'option_unavailable' });

    await products.setOptionAvailability(g1.options[2].id, true);
  });

  it('6. misma clave de idempotencia + otras carnes = 409 idempotency_key_reused; mismo cuerpo = el mismo pedido (200)', async () => {
    const zeus = await catalog(zeusId);
    const [g1, g2] = zeus.optionGroups;
    const customer = await newCustomer();
    const body = (c1: number) => pickups(customer.id, [{ productId: zeusId, quantity: 1, selectedOptions: [{ groupId: g1.id, optionId: g1.options[c1].id }, { groupId: g2.id, optionId: g2.options[0].id }] }]);

    const first = await orders.create(body(0) as never, key('6'), 'pos');
    const retry = await orders.create(body(0) as never, key('6'), 'pos');
    expect(first.httpStatus).toBe(201);
    expect(retry.httpStatus).toBe(200);
    expect((retry.body as { id: string }).id).toBe((first.body as { id: string }).id);

    await expect(orders.create(body(1) as never, key('6'), 'pos')).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('7. «cambiar mi pedido»: el cart del replaceable lleva los ids y se puede reenviar tal cual a replacements', async () => {
    const zeus = await catalog(zeusId);
    const [g1, g2] = zeus.optionGroups;
    const customer = await newCustomer('98');
    const created = await orders.create(
      pickups(customer.id, [{ productId: zeusId, quantity: 1, selectedOptions: [{ groupId: g1.id, optionId: g1.options[1].id }, { groupId: g2.id, optionId: g2.options[2].id }] }], { channel: 'whatsapp' }) as never,
      key('7'),
      'whatsapp-gateway',
    );
    const orderId = (created.body as { id: string }).id;

    const replaceable = await replacement.resolveReplaceable(customer.phone, 'whatsapp');
    expect(replaceable.result).toBe('replaceable');
    if (replaceable.result !== 'replaceable') return;
    expect(replaceable.cart.items).toEqual([
      {
        productId: zeusId,
        quantity: 1,
        excludedComplements: [],
        selectedOptions: [
          { groupId: g1.id, optionId: g1.options[1].id },
          { groupId: g2.id, optionId: g2.options[2].id },
        ],
      },
    ]);

    const outcome = await replacement.createReplacement(
      { customerPhone: customer.phone, orderId, customerName: 'Ana', deliveryType: 'pickup', paymentMethod: 'cash', items: [{ ...replaceable.cart.items[0], quantity: 2 }] } as never,
      key('7r'),
      'whatsapp-gateway',
      'whatsapp',
    );
    expect(outcome.body).toMatchObject({ result: 'replaced', replacedOrderId: orderId });
    const replacementOrder = await orders.findById((outcome.body as { orderId: string }).orderId);
    expect(replacementOrder.subtotalAmount).toBe(350);
    expect(replacementOrder.items[0].selectedOptions?.map((o) => o.optionCode)).toEqual(['chancho', 'costilla-res']);
  });

  it('8. disponibilidad por día: el día de hoy en La Paz se vende; cualquier otro día, 409 not_available_today', async () => {
    const todayWeekday = localWeekdayAndMinute(new Date())!.weekday;
    const customer = await newCustomer();

    await db.updateTable('products').set({ available_weekdays: [todayWeekday] }).where('id', '=', sopaId).execute();
    expect(await catalog(sopaId)).toMatchObject({ availableWeekdays: [todayWeekday], isAvailableToday: true, isAvailable: true });
    const ok = await orders.create(pickups(customer.id, [{ productId: sopaId, quantity: 1 }]) as never, key('8a'), 'pos');
    expect(ok.httpStatus).toBe(201);

    const otherDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== todayWeekday);
    await db.updateTable('products').set({ available_weekdays: otherDays }).where('id', '=', sopaId).execute();
    expect(await catalog(sopaId)).toMatchObject({ isAvailableToday: false, isAvailable: true });
    const error = await orders.create(pickups(customer.id, [{ productId: sopaId, quantity: 1 }]) as never, key('8b'), 'pos').catch((e) => e as DomainException);
    expect(error).toMatchObject({ code: 'product_unavailable' });
    expect((error as DomainException).getResponse()).toMatchObject({ details: { reason: 'not_available_today', productId: sopaId, availableWeekdays: otherDays } });

    await db.updateTable('products').set({ available_weekdays: null }).where('id', '=', sopaId).execute();
  });

  it('9. un producto con opciones obligatorias no puede entrar en una promoción; uno sin grupos sí', async () => {
    const promotions = new PromotionsService(db);

    await expect(
      promotions.create({ name: `e2e-opts-${RUN}-combo`, promoPrice: 100, items: [{ productId: zeusId, quantity: 1 }] } as never),
    ).rejects.toMatchObject({ code: 'promotion_product_requires_options' });

    const ok = await promotions.create({ name: `e2e-opts-${RUN}-combo-ok`, promoPrice: 10, items: [{ productId: sopaId, quantity: 1 }] } as never);
    promotionIds.push(ok.id);
    expect(ok.items).toHaveLength(1);
  });

  it('10. ronda de mesa: las carnes se guardan por línea, se ven en la cuenta y suman al total', async () => {
    const floor = await db.insertInto('floors').values({ name: `e2e-opts-floor-${RUN}` }).returning('id').executeTakeFirstOrThrow();
    floorId = floor.id;
    const table = await db.insertInto('tables').values({ floor_id: floor.id, label: 'M-OPT' }).returning('id').executeTakeFirstOrThrow();
    const zeus = await catalog(zeusId);
    const [g1, g2] = zeus.optionGroups;
    await accounts.open(table.id, {} as never, 'e2e');

    const round = { items: [{ productId: zeusId, quantity: 1, selectedOptions: [{ groupId: g1.id, optionId: g1.options[0].id }, { groupId: g2.id, optionId: g2.options[1].id }] }] };
    const added = await accounts.addRound(table.id, round as never, key('10'), 'e2e');

    const [line] = added.body.rounds[0].items;
    expect(line.selectedOptions).toEqual([
      { groupName: 'Carne 1', optionName: 'pollo', priceDelta: 0 },
      { groupName: 'Carne 2', optionName: 'chancho', priceDelta: 0 },
    ]);
    expect(added.body.totalAmount).toBe(175);

    // Un reintento con la misma clave devuelve la misma ronda sin duplicarla.
    const retry = await accounts.addRound(table.id, round as never, key('10'), 'e2e');
    expect(retry.created).toBe(false);
    expect(retry.body.rounds[0].items).toHaveLength(1);
  });
});
