import { IsIn } from 'class-validator';
import { OrderStatus } from '../../database/types';

const STATUSES: OrderStatus[] = [
  'draft',
  'awaiting_location',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
  'delivered',
  'cancelled',
];

export class UpdateOrderStatusDto {
  @IsIn(STATUSES)
  to!: OrderStatus;
}
