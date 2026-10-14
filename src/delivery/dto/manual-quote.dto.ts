import { IsNumber, Min } from 'class-validator';

export class ManualQuoteDto {
  @IsNumber()
  @Min(0)
  amount!: number;
}
