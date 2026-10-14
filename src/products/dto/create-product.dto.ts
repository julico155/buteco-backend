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

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  description?: string;

  @IsUUID()
  categoryId!: string;

  @IsNumber()
  @Min(0)
  price!: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  // Todos tildados por defecto en el pedido — esta lista es solo el catálogo
  // de qué se puede destildar (ej. tomate/lechuga/cebolla/pepinillo).
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductComplementInputDto)
  complements?: ProductComplementInputDto[];
}
