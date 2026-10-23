import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Contrato con el menú: identifica la opción (p. ej. qué recorte de carne dibujar). Minúsculas, números y guiones. */
const CODE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export class ProductOptionInputDto {
  @IsString()
  @MaxLength(60)
  @Matches(CODE_PATTERN, { message: 'code solo admite minúsculas, números y guiones (ej. "costilla-res").' })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  /** Se suma al precio base del producto. 0 por defecto. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  priceDelta?: number;

  /** false = agotada (p. ej. se acabó una carne). true por defecto. */
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class ProductOptionGroupInputDto {
  @IsString()
  @MaxLength(60)
  @Matches(CODE_PATTERN, { message: 'code solo admite minúsculas, números y guiones (ej. "carne-1").' })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  /** Cuántas opciones del grupo hay que elegir como mínimo. 1 por defecto (0 = grupo opcional). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  minSelect?: number;

  /** Cuántas como máximo. 1 por defecto. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxSelect?: number;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  /** true: lo elegido en este grupo se nombra en el aviso de delivery (p. ej. «Tamaño» → «1 persona»). */
  @IsOptional()
  @IsBoolean()
  showInNotice?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ProductOptionInputDto)
  options!: ProductOptionInputDto[];
}

/** Reemplaza la lista COMPLETA de grupos del producto; los que ya existen se identifican por `code` y conservan su id. */
export class ReplaceProductOptionGroupsDto {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ProductOptionGroupInputDto)
  groups!: ProductOptionGroupInputDto[];
}
