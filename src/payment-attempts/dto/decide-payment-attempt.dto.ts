import { IsIn } from 'class-validator';

export class DecidePaymentAttemptDto {
  @IsIn(['accepted', 'rejected'])
  decision!: 'accepted' | 'rejected';
}
