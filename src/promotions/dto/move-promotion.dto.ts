import { IsInt } from 'class-validator';

export class MovePromotionDto {
  @IsInt()
  sortOrder!: number;
}
