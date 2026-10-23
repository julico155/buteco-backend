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

  // (null = borrar el valor.) Días de la semana en que se vende (domingo = 0 … sábado = 6, día calendario de America/La_Paz). null = todos los días.
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  availableWeekdays?: number[] | null;

  // «2 a 3 personas». Se nombra en el aviso de delivery.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  servesLabel?: string | null;

  // Minutos de preparación; el aviso de delivery muestra el máximo del pedido.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  prepMinutes?: number | null;
}
