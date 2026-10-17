import { IsNumber, Max, Min } from 'class-validator';

/**
 * Ubicación de entrega elegida en el checkout web, mandada al CREAR el pedido (extensión opcional de `POST /orders` y de
 * los reemplazos). Solo estos dos campos, ambos numéricos y finitos (no se aceptan textos como "-17.7"); cualquier otro
 * campo lo rechaza el ValidationPipe global (`forbidNonWhitelisted`). Ningún importe de delivery viaja aquí: Central lo calcula.
 */
export class DeliveryLocationDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude!: number;
}
