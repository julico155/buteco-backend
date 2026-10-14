import { IsLatitude, IsLongitude, IsNumber, IsOptional, IsUUID, Min } from 'class-validator';

export class QuoteDeliveryDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsLatitude()
  latitude!: number;

  @IsLongitude()
  longitude!: number;

  /**
   * Subtotal de la comida, si ya se conoce. Solo sirve para saber si el envío
   * sale gratis por superar el monto configurado; sin él se cotiza la tarifa
   * normal.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  subtotalAmount?: number;
}
