import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class OrderPromotionInputDto {
  @IsUUID()
  promotionId!: string;

  @IsInt()
  @Min(1)
  @Max(30)
  quantity!: number;

  /**
   * Revisión de la promoción vista por el cliente al armar el carrito. Si no
   * coincide con `promotions.revision` actual, la promoción se trata como no
   * disponible (P1005 en el diseño original) — evita cobrar términos que el
   * cliente nunca vio (precio/componentes cambiaron después de mostrarse).
   */
  @IsInt()
  revision!: number;
}
