import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CloseCashRegisterDto {
  @IsNumber()
  @Min(0)
  countedCashAmount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
