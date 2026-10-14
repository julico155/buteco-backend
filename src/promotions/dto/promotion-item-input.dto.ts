import { IsInt, IsUUID, Min } from 'class-validator';

export class PromotionItemInputDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}
