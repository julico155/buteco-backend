import { DomainException } from '../common/exceptions/domain-exception';
import { OrdersService } from './orders.service';

/**
 * `priceCart` con opciones de producto y disponibilidad por día, contra una transacción falsa que responde por tabla.
 * La atomicidad y los `for share` reales solo los demuestra PostgreSQL; aquí se fija la regla de negocio.
 */
const SATURDAY_NOON = new Date('2026-10-24T16:00:00Z'); // sábado 12:00 en La Paz
const MONDAY_NOON = new Date('2026-10-26T16:00:00Z');

const ZEUS = '11111111-1111-4111-8111-111111111111';
const TABLITA = '22222222-2222-4222-8222-222222222222';
const SOPA = '33333333-3333-4333-8333-333333333333';

const product = (id: string, name: string, price: string, extra: Record<string, unknown> = {}) => ({
  id,
  code: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  price,
  is_active: true,
  is_available: true,
  available_weekdays: null,
  serves_label: null,
  prep_minutes: null,
  ...extra,
});

const PRODUCTS = [
  product(ZEUS, 'Tabla de Zeus', '175.00', { serves_label: '2 a 3 personas', prep_minutes: 40 }),
  product(TABLITA, 'Tablita de pollo', '50.00'),
  product(SOPA, 'Sopa de maní', '15.00', { available_weekdays: [6, 0] }),
];

const GROUPS = [
  { id: 'g-c1', product_id: ZEUS, code: 'carne-1', name: 'Carne 1', min_select: 1, max_select: 1, show_in_notice: false },
  { id: 'g-c2', product_id: ZEUS, code: 'carne-2', name: 'Carne 2', min_select: 1, max_select: 1, show_in_notice: false },
  { id: 'g-tam', product_id: TABLITA, code: 'tamano', name: 'Tamaño', min_select: 1, max_select: 1, show_in_notice: true },
];

const OPTIONS = [
  { id: 'o-c1-pollo', group_id: 'g-c1', code: 'pollo', name: 'Pollo', price_delta: '0.00', is_available: true },
  { id: 'o-c1-pescado', group_id: 'g-c1', code: 'pescado', name: 'Pescado', price_delta: '0.00', is_available: false },
  { id: 'o-c2-pollo', group_id: 'g-c2', code: 'pollo', name: 'Pollo', price_delta: '0.00', is_available: true },
  { id: 'o-tam-1', group_id: 'g-tam', code: '1-persona', name: '1 persona', price_delta: '0.00', is_available: true },
  { id: 'o-tam-2', group_id: 'g-tam', code: '2-personas', name: '2 personas', price_delta: '50.00', is_available: true },
];

function fakeTrx(now: Date) {
  const tables: Record<string, unknown[]> = {
    products: PRODUCTS,
    product_option_groups: GROUPS,
    product_options: OPTIONS,
  };
  const trx = {
    selectFrom: (table: string) => {
      const api: Record<string, unknown> = {};
      for (const method of ['select', 'selectAll', 'where', 'orderBy', 'forShare']) api[method] = () => api;
      api.execute = async () => tables[table] ?? [];
      return api;
    },
    // `sql\`select now()\`.execute(trx)`
    getExecutor: () => ({
      transformQuery: (node: unknown) => node,
      compileQuery: (node: unknown) => ({ query: node, sql: 'select now()', parameters: [] }),
      executeQuery: async () => ({ rows: [{ now }] }),
    }),
  };
  return trx as never;
}

function service(): OrdersService {
  return new OrdersService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; status: number; details: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error) {
    const e = error as DomainException;
    return { code: e.code, status: e.getStatus(), details: (e.getResponse() as { details: Record<string, unknown> }).details };
  }
  throw new Error('debía lanzar');
}

const zeus = (c1 = 'o-c1-pollo', c2 = 'o-c2-pollo') => ({
  productId: ZEUS,
  quantity: 1,
  selectedOptions: [
    { groupId: 'g-c1', optionId: c1 },
    { groupId: 'g-c2', optionId: c2 },
  ],
});

describe('OrdersService.priceCart — opciones de producto', () => {
  it('precia con la base: precio fijo de la tabla + deltas, y congela el snapshot de la selección', async () => {
    const result = await service().priceCart(fakeTrx(SATURDAY_NOON), [{ ...zeus(), quantity: 2 }], []);

    expect(result.subtotal).toBe(350);
    expect(result.itemLines).toHaveLength(1);
    const [line] = result.itemLines;
    expect(line.unitPrice).toBe(175);
    expect(line.subtotal).toBe(350);
    expect(line.selectedOptions.map((o) => `${o.groupCode}:${o.optionCode}`)).toEqual(['carne-1:pollo', 'carne-2:pollo']);
  });

  it('una tablita de 2 personas suma el delta del tamaño (no el del cliente)', async () => {
    const result = await service().priceCart(
      fakeTrx(SATURDAY_NOON),
      [
        { productId: TABLITA, quantity: 1, selectedOptions: [{ groupId: 'g-tam', optionId: 'o-tam-2' }] },
        { productId: TABLITA, quantity: 1, selectedOptions: [{ groupId: 'g-tam', optionId: 'o-tam-1' }] },
      ],
      [],
    );

    expect(result.itemLines.map((l) => [l.unitPrice, l.subtotal])).toEqual([
      [100, 100],
      [50, 50],
    ]);
    expect(result.subtotal).toBe(150);
    expect(result.itemLines[0].selectedOptions[0]).toMatchObject({ optionName: '2 personas', priceDelta: 50, showInNotice: true });
  });

  it('dos líneas del mismo producto con otras carnes son líneas distintas', async () => {
    const result = await service().priceCart(
      fakeTrx(SATURDAY_NOON),
      [
        { productId: TABLITA, quantity: 1, selectedOptions: [{ groupId: 'g-tam', optionId: 'o-tam-1' }] },
        { productId: TABLITA, quantity: 1, selectedOptions: [{ groupId: 'g-tam', optionId: 'o-tam-2' }] },
      ],
      [],
    );
    expect(result.itemLines).toHaveLength(2);
  });

  it('la misma selección en otro orden es la misma línea: se rechaza como duplicada', async () => {
    const forward = zeus();
    const reversed = { ...zeus(), selectedOptions: [...zeus().selectedOptions].reverse() };
    const error = await failure(service().priceCart(fakeTrx(SATURDAY_NOON), [forward, reversed], []));
    expect(error.code).toBe('validation_error');
  });

  it('un producto con grupos obligatorios sin selección se rechaza (400 invalid_option_selection)', async () => {
    const error = await failure(service().priceCart(fakeTrx(SATURDAY_NOON), [{ productId: ZEUS, quantity: 1 }], []));
    expect(error.code).toBe('invalid_option_selection');
    expect(error.status).toBe(400);
    expect(error.details).toMatchObject({ reason: 'too_few', productId: ZEUS });
  });

  it('una carne agotada se rechaza con 409 option_unavailable', async () => {
    const error = await failure(service().priceCart(fakeTrx(SATURDAY_NOON), [zeus('o-c1-pescado')], []));
    expect(error.code).toBe('option_unavailable');
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({ optionId: 'o-c1-pescado', unavailableOptionIds: ['o-c1-pescado'] });
  });

  it('las opciones de otro producto no valen', async () => {
    const error = await failure(
      service().priceCart(fakeTrx(SATURDAY_NOON), [{ productId: ZEUS, quantity: 1, selectedOptions: [{ groupId: 'g-tam', optionId: 'o-tam-2' }] }], []),
    );
    expect(error.code).toBe('invalid_option_selection');
    expect(error.details).toMatchObject({ reason: 'unknown_group' });
  });

  it('un producto sin grupos se precia exactamente como antes', async () => {
    const result = await service().priceCart(fakeTrx(SATURDAY_NOON), [{ productId: SOPA, quantity: 3 }], []);
    expect(result.itemLines[0]).toMatchObject({ unitPrice: 15, subtotal: 45, selectedOptions: [] });
  });
});

describe('OrdersService.priceCart — disponibilidad por día', () => {
  it('la sopa de maní se vende el sábado', async () => {
    const result = await service().priceCart(fakeTrx(SATURDAY_NOON), [{ productId: SOPA, quantity: 1 }], []);
    expect(result.subtotal).toBe(15);
  });

  it('el lunes se rechaza con 409 product_unavailable / not_available_today y los días en que sí se cocina', async () => {
    const error = await failure(service().priceCart(fakeTrx(MONDAY_NOON), [{ productId: SOPA, quantity: 1 }], []));
    expect(error.code).toBe('product_unavailable');
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({
      productId: SOPA,
      reason: 'not_available_today',
      unavailableProductIds: [SOPA],
      availableWeekdays: [6, 0],
    });
  });

  it('los demás productos no se ven afectados el lunes', async () => {
    const result = await service().priceCart(fakeTrx(MONDAY_NOON), [{ productId: TABLITA, quantity: 1, selectedOptions: [{ groupId: 'g-tam', optionId: 'o-tam-1' }] }], []);
    expect(result.subtotal).toBe(50);
  });
});
