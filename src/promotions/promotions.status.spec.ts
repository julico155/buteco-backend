import { computeStatus, PromotionItemRow, PromotionRow } from './promotions.service';

function basePromotion(overrides: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id: 'promo-1',
    name: 'Combo test',
    description: null,
    promo_price: '20.00',
    is_active: true,
    archived_at: null,
    starts_at: null,
    ends_at: null,
    sort_order: 0,
    image_url: null,
    revision: 1,
    ...overrides,
  };
}

function item(overrides: Partial<PromotionItemRow> = {}): PromotionItemRow {
  return {
    promotion_id: 'promo-1',
    product_id: 'product-1',
    product_name: 'Producto',
    quantity: 1,
    unit_price: '15.00',
    product_is_active: true,
    product_is_available: true,
    ...overrides,
  };
}

describe('computeStatus (invariante 4 y reglas de vigencia del plan)', () => {
  it('archivada tiene prioridad sobre cualquier otro estado', () => {
    const promo = basePromotion({ archived_at: new Date(), is_active: false });
    expect(computeStatus(promo, [item()])).toBe('archivada');
  });

  it('inactiva si is_active es false y no está archivada', () => {
    const promo = basePromotion({ is_active: false });
    expect(computeStatus(promo, [item()])).toBe('inactiva');
  });

  it('programada si starts_at es futuro', () => {
    const promo = basePromotion({ starts_at: new Date(Date.now() + 86_400_000) });
    expect(computeStatus(promo, [item()])).toBe('programada');
  });

  it('expirada si ends_at ya pasó', () => {
    const promo = basePromotion({ ends_at: new Date(Date.now() - 86_400_000) });
    expect(computeStatus(promo, [item()])).toBe('expirada');
  });

  it('agotada si algún producto del combo está inactivo o sin stock (invariante 4: sold-out != inactivo, pero ambos agotan el combo)', () => {
    const inactivo = basePromotion();
    expect(computeStatus(inactivo, [item({ product_is_active: false })])).toBe('agotada');

    const soldOut = basePromotion();
    expect(computeStatus(soldOut, [item({ product_is_available: false })])).toBe('agotada');
  });

  it('sin_ahorro si el precio promo no es menor que la suma de precios regulares', () => {
    // 2 items de 15.00 c/u = 30.00 regular; promo_price 30.00 -> sin ahorro real.
    const promo = basePromotion({ promo_price: '30.00' });
    const items = [
      item({ unit_price: '15.00', quantity: 1 }),
      item({ unit_price: '15.00', quantity: 1 }),
    ];
    expect(computeStatus(promo, items)).toBe('sin_ahorro');
  });

  it('activa cuando no aplica ninguna condición anterior y hay ahorro real', () => {
    const promo = basePromotion({ promo_price: '20.00' });
    const items = [item({ unit_price: '15.00', quantity: 2 })]; // regular = 30.00 > 20.00
    expect(computeStatus(promo, items)).toBe('activa');
  });
});
