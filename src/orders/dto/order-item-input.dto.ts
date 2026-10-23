import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Una opción elegida: solo ids. Central calcula el precio y valida contra el catálogo. */
export class SelectedOptionInputDto {
  @IsUUID()
  groupId!: string;

  @IsUUID()
  optionId!: string;
}

export class OrderItemInputDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(30)
  quantity!: number;

  /**
   * Nombres de complementos del producto a EXCLUIR (ej. ["cebolla"]) — por
   * defecto todos van incluidos. Distintas selecciones del mismo producto se
   * mandan como líneas separadas (no se puede pedir "3 hamburguesas, 1 sin
   * cebolla" en una sola línea): cada una vuelve un order_item propio.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  excludedComplements?: string[];

  /**
   * OPCIONAL. Opciones elegidas de los grupos del producto (ej. las carnes de una tabla, el tamaño). Solo ids: Central
   * calcula el precio (`base + Σ priceDelta`) y valida que cada grupo sea del producto, que se cumplan `minSelect` /
   * `maxSelect` y que la opción esté disponible. Un producto sin grupos no lleva este campo. La misma opción puede
   * repetirse en grupos distintos del mismo ítem.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SelectedOptionInputDto)
  selectedOptions?: SelectedOptionInputDto[];
}
