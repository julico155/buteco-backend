import { ApiProperty } from '@nestjs/swagger';

export const PROMOTION_STATUS_VALUES = [
  'activa',
  'agotada',
  'sin_ahorro',
  'inactiva',
  'archivada',
  'programada',
  'expirada',
] as const;
export type PromotionStatus = (typeof PROMOTION_STATUS_VALUES)[number];

export class PromotionItemResponse {
  productId!: string;
  productName!: string;
  quantity!: number;
  unitPrice!: number;
}

export class PromotionResponse {
  id!: string;
  name!: string;
  description!: string | null;
  promoPrice!: number;
  isActive!: boolean;
  archivedAt!: string | null;
  startsAt!: string | null;
  endsAt!: string | null;
  sortOrder!: number;
  imageUrl!: string | null;
  revision!: number;
  @ApiProperty({ enum: PROMOTION_STATUS_VALUES })
  status!: PromotionStatus;
  items!: PromotionItemResponse[];
}
