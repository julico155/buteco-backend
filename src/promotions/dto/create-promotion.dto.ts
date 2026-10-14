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

export class CreatePromotionDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @Min(0.01)
  @Max(5000)
  promoPrice!: number;

  // Al menos 1: una promoción puede ser un solo producto (varias unidades,
  // o incluso una sola) con un precio especial — no hace falta que sea un
  // combo de productos distintos.
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PromotionItemInputDto)
  items!: PromotionItemInputDto[];

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
