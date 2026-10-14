import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PromotionItemInputDto } from './promotion-item-input.dto';

export class UpdatePromotionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(5000)
  promoPrice?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PromotionItemInputDto)
  items?: PromotionItemInputDto[];

  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @IsOptional()
  @IsUrl()
  imageUrl?: string;
}
