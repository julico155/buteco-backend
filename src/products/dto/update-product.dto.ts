import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ProductComplementInputDto } from './product-complement-input.dto';

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  description?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  // Si viene, reemplaza la lista completa de complementos del producto.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductComplementInputDto)
  complements?: ProductComplementInputDto[];
}
