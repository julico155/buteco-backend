import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
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

  // Días de la semana en que se vende (domingo = 0 … sábado = 6, día calendario de America/La_Paz). Omitido = todos los días.
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  availableWeekdays?: number[];

  // «2 a 3 personas». Se nombra en el aviso de delivery.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  servesLabel?: string;

  // Minutos de preparación; el aviso de delivery muestra el máximo del pedido.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  prepMinutes?: number;
}
