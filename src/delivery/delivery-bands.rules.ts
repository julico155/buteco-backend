import { ValidationError } from '../common/exceptions/domain-exception';

export interface TariffBandInput {
  maxDistanceMeters: number;
  feeAmount: number;
}

export const MAX_TARIFF_BANDS = 50;

/**
 * Valida la tabla de bandas completa antes de reemplazarla. La banda k cubre
 * (máximo de la k-1, máximo de la k], así que las distancias tienen que ser
 * estrictamente crecientes: con un orden distinto la búsqueda por distancia
 * (`feeForMeters`) cobraría la banda equivocada sin avisar.
 */
export function validateTariffBands(bands: TariffBandInput[]): void {
  if (bands.length === 0) {
    throw new ValidationError('Tiene que haber al menos una banda de tarifa.');
  }
  if (bands.length > MAX_TARIFF_BANDS) {
    throw new ValidationError(`Máximo ${MAX_TARIFF_BANDS} bandas de tarifa.`, { max: MAX_TARIFF_BANDS });
  }

  let previous = 0;
  bands.forEach((band, index) => {
    const position = index + 1;
    if (!Number.isInteger(band.maxDistanceMeters) || band.maxDistanceMeters <= 0) {
      throw new ValidationError(`Banda ${position}: la distancia máxima tiene que ser un entero de metros mayor que cero.`, {
        band: position,
      });
    }
    if (band.maxDistanceMeters <= previous) {
      throw new ValidationError(
        `Banda ${position}: la distancia máxima tiene que ser mayor que la de la banda anterior (${previous} m).`,
        { band: position, previousMaxDistanceMeters: previous },
      );
    }
    if (!Number.isFinite(band.feeAmount) || band.feeAmount < 0) {
      throw new ValidationError(`Banda ${position}: la tarifa tiene que ser un monto de cero o más.`, {
        band: position,
      });
    }
    if (Math.round(band.feeAmount * 100) / 100 !== band.feeAmount) {
      throw new ValidationError(`Banda ${position}: la tarifa admite como mucho 2 decimales.`, { band: position });
    }
    previous = band.maxDistanceMeters;
  });
}
