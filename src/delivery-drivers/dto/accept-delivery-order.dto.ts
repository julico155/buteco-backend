import { IsNumber, IsOptional, Max, Min } from 'class-validator';

export class AcceptDeliveryOrderDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  /** `coords.accuracy` del navegador, en metros. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracyMeters?: number;
}
