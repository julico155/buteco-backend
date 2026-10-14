import { IsIn } from 'class-validator';
import { OrderStatus } from '../../database/types';

/**
 * Solo los cierres manuales: entregado (recojo/mesa), despachado (delivery) y
 * cancelado. `preparing` y `ready` ya no se pueden elegir.
 */
const STATUSES: OrderStatus[] = ['out_for_delivery', 'delivered', 'cancelled'];

export class UpdateOrderStatusDto {
  @IsIn(STATUSES)
  to!: OrderStatus;
}
