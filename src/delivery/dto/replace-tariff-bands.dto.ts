import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, Min, ValidateNested } from 'class-validator';
import { MAX_TARIFF_BANDS } from '../delivery-bands.rules';

export class TariffBandDto {
  /** Hasta qué distancia (m, por calle o en línea recta) llega esta banda. */
  @IsInt()
  @Min(1)
  maxDistanceMeters!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  feeAmount!: number;
}

/** La lista completa y en orden: la posición define el `band_index` (1..n). */
export class ReplaceTariffBandsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_TARIFF_BANDS)
  @ValidateNested({ each: true })
  @Type(() => TariffBandDto)
  bands!: TariffBandDto[];
}
