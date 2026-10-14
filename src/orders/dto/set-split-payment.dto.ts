import { IsNumber, Min } from 'class-validator';

export class SetSplitPaymentDto {
  @IsNumber()
  @Min(0.01)
  cashAmount!: number;

  @IsNumber()
  @Min(0.01)
  qrAmount!: number;
}
