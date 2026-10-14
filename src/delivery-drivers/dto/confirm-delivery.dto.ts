import { IsBoolean, IsOptional } from 'class-validator';

export class ConfirmDeliveryDto {
  /**
   * Solo relevante si el pedido es `payment_method='cash'`: ¿se cobró todo
   * (comida + envío) al entregar? Default `true` — el negocio no se mete en
   * cómo el repartidor arregla el cobro con el cliente, pero necesita saber
   * si quedó pendiente para el cuadre de fin de noche (se le cobra a la
   * moto). Mandar `false` explícito cuando el cliente no pagó.
   */
  @IsOptional()
  @IsBoolean()
  cashCollected?: boolean;
}
