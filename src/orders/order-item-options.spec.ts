import { DomainException } from '../common/exceptions/domain-exception';
import {
  isAvailableOnDay,
  itemLineKey,
  maxPrepMinutes,
  OptionGroupRow,
  OptionRow,
  resolveSelectedOptions,
  toSelectedOptionResponse,
} from './order-item-options';

const PRODUCT = 'product-zeus';

const group = (id: string, overrides: Partial<OptionGroupRow> = {}): OptionGroupRow => ({
  id,
  product_id: PRODUCT,
  code: id,
  name: id.toUpperCase(),
  min_select: 1,
  max_select: 1,
  show_in_notice: false,
  ...overrides,
});

const option = (id: string, groupId: string, overrides: Partial<OptionRow> = {}): OptionRow => ({
  id,
  group_id: groupId,
  code: id,
  name: id.toUpperCase(),
  price_delta: '0.00',
  is_available: true,
  ...overrides,
});

// Tabla de Zeus: dos carnes a elección, ambas del mismo catálogo de 3 carnes.
const GROUPS = [group('carne-1'), group('carne-2')];
const OPTIONS = [
  option('o-pollo-1', 'carne-1', { code: 'pollo' }),
  option('o-chancho-1', 'carne-1', { code: 'chancho' }),
  option('o-pollo-2', 'carne-2', { code: 'pollo' }),
  option('o-pescado-2', 'carne-2', { code: 'pescado', is_available: false }),
];

async function codeOf(fn: () => unknown): Promise<{ code: string; details?: Record<string, unknown> }> {
  try {
    fn();
  } catch (error) {
    const e = error as DomainException;
    return { code: e.code, details: (e.getResponse() as { details?: Record<string, unknown> }).details };
  }
  throw new Error('debía lanzar');
}

describe('resolveSelectedOptions', () => {
  it('devuelve el snapshot en el orden de los grupos del catálogo y suma los deltas', () => {
    const groups = [group('tamano', { show_in_notice: true }), ...GROUPS];
    const options = [option('o-2p', 'tamano', { code: '2-personas', name: '2 personas', price_delta: '50.00' }), ...OPTIONS];

    const result = resolveSelectedOptions({
      productId: PRODUCT,
      // El cliente las manda en otro orden: el snapshot sale ordenado por grupo.
      selected: [
        { groupId: 'carne-2', optionId: 'o-pollo-2' },
        { groupId: 'tamano', optionId: 'o-2p' },
        { groupId: 'carne-1', optionId: 'o-chancho-1' },
      ],
      groups,
      options,
    });

    expect(result.priceDelta).toBe(50);
    expect(result.selectedOptions.map((o) => o.groupCode)).toEqual(['tamano', 'carne-1', 'carne-2']);
    expect(result.selectedOptions[0]).toEqual({
      groupId: 'tamano',
      optionId: 'o-2p',
      groupCode: 'tamano',
      groupName: 'TAMANO',
      optionCode: '2-personas',
      optionName: '2 personas',
      priceDelta: 50,
      showInNotice: true,
    });
  });

  it('permite repetir la misma carne en dos grupos distintos del mismo ítem', () => {
    const result = resolveSelectedOptions({
      productId: PRODUCT,
      selected: [
        { groupId: 'carne-1', optionId: 'o-pollo-1' },
        { groupId: 'carne-2', optionId: 'o-pollo-2' },
      ],
      groups: GROUPS,
      options: OPTIONS,
    });
    expect(result.selectedOptions.map((o) => o.optionCode)).toEqual(['pollo', 'pollo']);
  });

  it('un producto sin grupos y sin selección no suma nada', () => {
    expect(resolveSelectedOptions({ productId: PRODUCT, selected: undefined, groups: [], options: [] })).toEqual({
      selectedOptions: [],
      priceDelta: 0,
    });
  });

  it('rechaza un grupo que no es del producto', async () => {
    const error = await codeOf(() =>
      resolveSelectedOptions({
        productId: PRODUCT,
        selected: [{ groupId: 'otro-grupo', optionId: 'o-pollo-1' }],
        groups: GROUPS,
        options: OPTIONS,
      }),
    );
    expect(error.code).toBe('invalid_option_selection');
    expect(error.details).toMatchObject({ reason: 'unknown_group', groupId: 'otro-grupo' });
  });

  it('rechaza una opción que no pertenece al grupo indicado', async () => {
    const error = await codeOf(() =>
      resolveSelectedOptions({
        productId: PRODUCT,
        selected: [
          { groupId: 'carne-1', optionId: 'o-pollo-2' }, // es de carne-2
          { groupId: 'carne-2', optionId: 'o-pollo-2' },
        ],
        groups: GROUPS,
        options: OPTIONS,
      }),
    );
    expect(error.details).toMatchObject({ reason: 'unknown_option', optionId: 'o-pollo-2' });
  });

  it('rechaza la misma opción dos veces dentro de un mismo grupo', async () => {
    const groups = [group('carne-1', { max_select: 2 })];
    const error = await codeOf(() =>
      resolveSelectedOptions({
        productId: PRODUCT,
        selected: [
          { groupId: 'carne-1', optionId: 'o-pollo-1' },
          { groupId: 'carne-1', optionId: 'o-pollo-1' },
        ],
        groups,
        options: OPTIONS,
      }),
    );
    expect(error.details).toMatchObject({ reason: 'duplicate_option' });
  });

  it('exige elegir en cada grupo obligatorio, aunque el cliente no mande nada', async () => {
    const none = await codeOf(() => resolveSelectedOptions({ productId: PRODUCT, selected: undefined, groups: GROUPS, options: OPTIONS }));
    expect(none.details).toMatchObject({ reason: 'too_few', minSelect: 1, maxSelect: 1 });

    const half = await codeOf(() =>
      resolveSelectedOptions({
        productId: PRODUCT,
        selected: [{ groupId: 'carne-1', optionId: 'o-pollo-1' }],
        groups: GROUPS,
        options: OPTIONS,
      }),
    );
    expect(half.details).toMatchObject({ reason: 'too_few', groupId: 'carne-2' });
  });

  it('respeta maxSelect y deja pasar un grupo opcional sin elegir', async () => {
    const optional = [group('extra', { min_select: 0, max_select: 1 })];
    expect(resolveSelectedOptions({ productId: PRODUCT, selected: [], groups: optional, options: [] }).selectedOptions).toEqual([]);

    const tooMany = await codeOf(() =>
      resolveSelectedOptions({
        productId: PRODUCT,
        selected: [
          { groupId: 'carne-1', optionId: 'o-pollo-1' },
          { groupId: 'carne-1', optionId: 'o-chancho-1' },
          { groupId: 'carne-2', optionId: 'o-pollo-2' },
        ],
        groups: GROUPS,
        options: OPTIONS,
      }),
    );
    expect(tooMany.details).toMatchObject({ reason: 'too_many', groupId: 'carne-1' });
  });

  it('una opción agotada se rechaza con option_unavailable (409) y dice cuáles', async () => {
    const error = await codeOf(() =>
      resolveSelectedOptions({
        productId: PRODUCT,
        selected: [
          { groupId: 'carne-1', optionId: 'o-pollo-1' },
          { groupId: 'carne-2', optionId: 'o-pescado-2' },
        ],
        groups: GROUPS,
        options: OPTIONS,
      }),
    );
    expect(error.code).toBe('option_unavailable');
    expect(error.details).toEqual({
      productId: PRODUCT,
      groupId: 'carne-2',
      optionId: 'o-pescado-2',
      unavailableOptionIds: ['o-pescado-2'],
    });
  });

  it('una selección inválida gana sobre una opción agotada', async () => {
    const error = await codeOf(() =>
      resolveSelectedOptions({
        productId: PRODUCT,
        selected: [{ groupId: 'carne-2', optionId: 'o-pescado-2' }],
        groups: GROUPS,
        options: OPTIONS,
      }),
    );
    expect(error.code).toBe('invalid_option_selection');
  });

  it('toSelectedOptionResponse no expone la bandera interna showInNotice', () => {
    const response = toSelectedOptionResponse({
      groupId: 'g',
      optionId: 'o',
      groupCode: 'gc',
      groupName: 'G',
      optionCode: 'oc',
      optionName: 'O',
      priceDelta: 5,
      showInNotice: true,
    });
    expect(response).not.toHaveProperty('showInNotice');
    expect(response.priceDelta).toBe(5);
  });
});

describe('itemLineKey', () => {
  it('es insensible al orden de complementos y de opciones', () => {
    const a = itemLineKey({
      productId: 'p',
      excludedComplements: ['b', 'a'],
      selectedOptions: [
        { groupId: 'g1', optionId: 'o1' },
        { groupId: 'g2', optionId: 'o2' },
      ],
    });
    const b = itemLineKey({
      productId: 'p',
      excludedComplements: ['a', 'b'],
      selectedOptions: [
        { groupId: 'g2', optionId: 'o2' },
        { groupId: 'g1', optionId: 'o1' },
      ],
    });
    expect(a).toBe(b);
  });

  it('el mismo producto con otras carnes es otra línea; sin selección da la misma clave que con []', () => {
    const zeusPollo = itemLineKey({ productId: 'p', selectedOptions: [{ groupId: 'g1', optionId: 'pollo' }] });
    const zeusChancho = itemLineKey({ productId: 'p', selectedOptions: [{ groupId: 'g1', optionId: 'chancho' }] });
    expect(zeusPollo).not.toBe(zeusChancho);
    expect(itemLineKey({ productId: 'p' })).toBe(itemLineKey({ productId: 'p', selectedOptions: [] }));
  });
});

describe('isAvailableOnDay (día calendario de America/La_Paz)', () => {
  const SATURDAY_AND_SUNDAY = [6, 0];

  it('null = todos los días', () => {
    expect(isAvailableOnDay(null, new Date('2026-10-26T16:00:00Z'))).toBe(true);
    expect(isAvailableOnDay(undefined, new Date('2026-10-26T16:00:00Z'))).toBe(true);
  });

  it('la sopa de maní se vende sábado y domingo y no de lunes a viernes', () => {
    // 2026-10-23 es viernes. Mediodía en La Paz = 16:00 UTC.
    const noon = (day: string) => new Date(`${day}T16:00:00Z`);
    expect(isAvailableOnDay(SATURDAY_AND_SUNDAY, noon('2026-10-23'))).toBe(false); // viernes
    expect(isAvailableOnDay(SATURDAY_AND_SUNDAY, noon('2026-10-24'))).toBe(true); // sábado
    expect(isAvailableOnDay(SATURDAY_AND_SUNDAY, noon('2026-10-25'))).toBe(true); // domingo
    expect(isAvailableOnDay(SATURDAY_AND_SUNDAY, noon('2026-10-26'))).toBe(false); // lunes
  });

  it('el día cambia a las 00:00 de La Paz (04:00 UTC), no a las 00:00 UTC', () => {
    // Viernes 22:00 en La Paz ya es sábado en UTC: sigue siendo viernes para el negocio.
    expect(isAvailableOnDay(SATURDAY_AND_SUNDAY, new Date('2026-10-24T02:00:00Z'))).toBe(false);
    expect(isAvailableOnDay(SATURDAY_AND_SUNDAY, new Date('2026-10-24T04:00:00Z'))).toBe(true);
    // Domingo 23:30 en La Paz sigue siendo domingo; el lunes empieza a las 04:00 UTC.
    expect(isAvailableOnDay(SATURDAY_AND_SUNDAY, new Date('2026-10-26T03:30:00Z'))).toBe(true);
    expect(isAvailableOnDay(SATURDAY_AND_SUNDAY, new Date('2026-10-26T04:00:00Z'))).toBe(false);
  });

  it('un instante ilegible no vende un producto restringido', () => {
    expect(isAvailableOnDay(SATURDAY_AND_SUNDAY, new Date('no es una fecha'))).toBe(false);
  });
});

describe('maxPrepMinutes', () => {
  it('toma el máximo (no la suma) e ignora los productos sin tiempo', () => {
    expect(maxPrepMinutes([20, null, 40, undefined, 30])).toBe(40);
  });

  it('devuelve null si ningún producto declara tiempo', () => {
    expect(maxPrepMinutes([null, undefined])).toBeNull();
    expect(maxPrepMinutes([])).toBeNull();
  });
});
