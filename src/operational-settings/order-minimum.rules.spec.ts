import { DomainException } from '../common/exceptions/domain-exception';
import { assertMinimumOrder, minimumsFrom } from './order-minimum.rules';

const MINIMUMS = { delivery: 40, pickup: 0, dine_in: 15 };

function codeOf(fn: () => unknown): DomainException {
  try {
    fn();
  } catch (error) {
    return error as DomainException;
  }
  throw new Error('debía lanzar');
}

describe('minimumsFrom', () => {
  it('convierte los numeric (string) y trata faltantes como 0', () => {
    expect(
      minimumsFrom({ min_order_delivery: '40.00', min_order_pickup: '0.00', min_order_dine_in: '15.50' }),
    ).toEqual({ delivery: 40, pickup: 0, dine_in: 15.5 });
    expect(minimumsFrom({})).toEqual({ delivery: 0, pickup: 0, dine_in: 0 });
  });
});

describe('assertMinimumOrder', () => {
  it('0 = sin mínimo', () => {
    expect(() => assertMinimumOrder(MINIMUMS, 'pickup', 1)).not.toThrow();
  });

  it('acepta un subtotal que alcanza o supera el mínimo', () => {
    expect(() => assertMinimumOrder(MINIMUMS, 'delivery', 40)).not.toThrow();
    expect(() => assertMinimumOrder(MINIMUMS, 'delivery', 55)).not.toThrow();
  });

  it('rechaza uno por debajo, con 400 below_minimum_order y los montos', () => {
    const error = codeOf(() => assertMinimumOrder(MINIMUMS, 'delivery', 39.99));
    expect(error.code).toBe('below_minimum_order');
    expect(error.getStatus()).toBe(400);
    expect(error.details).toEqual({
      serviceType: 'delivery',
      minimumAmount: 40,
      subtotalAmount: 39.99,
    });
  });

  it('el mínimo es por tipo de servicio', () => {
    expect(() => assertMinimumOrder(MINIMUMS, 'dine_in', 14)).toThrow(DomainException);
    expect(() => assertMinimumOrder(MINIMUMS, 'pickup', 14)).not.toThrow();
  });

  it('no se deja engañar por error de punto flotante', () => {
    expect(() => assertMinimumOrder({ ...MINIMUMS, delivery: 30 }, 'delivery', 29.999999)).not.toThrow();
  });
});
