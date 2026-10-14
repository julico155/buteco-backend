import { IsNumber, Min } from 'class-validator';

export class OpenCashRegisterDto {
  @IsNumber()
  @Min(0)
  openingAmount!: number;
}
