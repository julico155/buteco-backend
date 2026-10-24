import { IsNumber, Max, Min } from 'class-validator';

export class CreateTopupDto {
  /** Monto de la recarga en Bs, hasta 2 decimales. El mínimo lo define `AGENT_TOPUP_MIN_AMOUNT`. */
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1_000_000)
  amount!: number;
}
