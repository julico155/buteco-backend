import { IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ProductComplementInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name!: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
