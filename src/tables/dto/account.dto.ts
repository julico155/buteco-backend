import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { OrderItemInputDto } from '../../orders/dto/order-item-input.dto';
import { OrderPromotionInputDto } from '../../orders/dto/order-promotion-input.dto';

export class OpenAccountDto {
  /** Si no viene, la cuenta lleva el nombre de la mesa. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  customerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class AddRoundDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items?: OrderItemInputDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => OrderPromotionInputDto)
  promotions?: OrderPromotionInputDto[];
}

export class CloseAccountDto {
  @IsIn(['cash', 'qr', 'split'])
  paymentMethod!: 'cash' | 'qr' | 'split';

  /** Solo con paymentMethod='split'. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  cashAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  qrAmount?: number;
}
