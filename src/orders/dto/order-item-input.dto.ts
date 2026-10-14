import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

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
}
