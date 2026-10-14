import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class MarkRefundedDto {
  /** Cómo se devolvió (transferencia, QR de vuelta, efectivo) y cualquier referencia, para la traza. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  notes?: string;
}
