import { IsNumber, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateAdjustmentDto {
  /** Bs con signo: positivo suma saldo, negativo lo resta. No puede ser 0. */
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(-1_000_000)
  @Max(1_000_000)
  amount!: number;

  /** Motivo, obligatorio: queda en el libro. */
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  note!: string;
}
