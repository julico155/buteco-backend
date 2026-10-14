import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class FindOrCreateCustomerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;
}
