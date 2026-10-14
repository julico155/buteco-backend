import { DomainException } from '../common/exceptions/domain-exception';
import { MAX_TARIFF_BANDS, validateTariffBands } from './delivery-bands.rules';

function errorOf(bands: Parameters<typeof validateTariffBands>[0]): DomainException {
  try {
    validateTariffBands(bands);
  } catch (error) {
    return error as DomainException;
  }
  throw new Error('debía lanzar');
}

const VALID = [
  { maxDistanceMeters: 1000, feeAmount: 5 },
  { maxDistanceMeters: 3000, feeAmount: 9.5 },
  { maxDistanceMeters: 8000, feeAmount: 16 },
];

describe('validateTariffBands', () => {
  it('acepta bandas con distancias crecientes', () => {
    expect(() => validateTariffBands(VALID)).not.toThrow();
  });

  it('acepta una sola banda y tarifa cero', () => {
    expect(() => validateTariffBands([{ maxDistanceMeters: 500, feeAmount: 0 }])).not.toThrow();
  });

  it('rechaza una lista vacía', () => {
    expect(errorOf([]).code).toBe('validation_error');
  });

  it('rechaza más del máximo de bandas', () => {
    const many = Array.from({ length: MAX_TARIFF_BANDS + 1 }, (_, i) => ({
      maxDistanceMeters: (i + 1) * 100,
      feeAmount: 1,
    }));
    expect(errorOf(many).code).toBe('validation_error');
  });

  it('rechaza distancias que no crecen (igual o menor que la anterior)', () => {
    const equal = errorOf([
      { maxDistanceMeters: 1000, feeAmount: 5 },
      { maxDistanceMeters: 1000, feeAmount: 7 },
    ]);
    expect(equal.details).toMatchObject({ band: 2, previousMaxDistanceMeters: 1000 });

    expect(
      errorOf([
        { maxDistanceMeters: 3000, feeAmount: 5 },
        { maxDistanceMeters: 1000, feeAmount: 7 },
      ]).code,
    ).toBe('validation_error');
  });

  it('rechaza distancias no enteras o no positivas', () => {
    expect(errorOf([{ maxDistanceMeters: 0, feeAmount: 5 }]).code).toBe('validation_error');
    expect(errorOf([{ maxDistanceMeters: 10.5, feeAmount: 5 }]).code).toBe('validation_error');
  });

  it('rechaza tarifas negativas, no finitas o con más de 2 decimales', () => {
    expect(errorOf([{ maxDistanceMeters: 1000, feeAmount: -1 }]).code).toBe('validation_error');
    expect(errorOf([{ maxDistanceMeters: 1000, feeAmount: Number.NaN }]).code).toBe('validation_error');
    expect(errorOf([{ maxDistanceMeters: 1000, feeAmount: 5.123 }]).code).toBe('validation_error');
  });
});
