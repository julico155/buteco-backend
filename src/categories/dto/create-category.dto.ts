import { IsBoolean, IsInt, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
