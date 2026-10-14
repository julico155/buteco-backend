import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectLateOrderRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
