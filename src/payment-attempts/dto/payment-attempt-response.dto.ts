import { ApiProperty } from '@nestjs/swagger';
import { PAYMENT_ATTEMPT_REVIEW_STATUS_VALUES } from '../../common/api-enums';
import { PaymentAttemptReviewStatus } from '../../database/types';

export class PaymentAttemptResponse {
  id!: string;
  orderId!: string;
  customerId!: string | null;
  openedAt!: string;
  openedAs!: string;
  @ApiProperty({ enum: PAYMENT_ATTEMPT_REVIEW_STATUS_VALUES })
  reviewStatus!: PaymentAttemptReviewStatus;
  reviewedAt!: string | null;
}

export class DecidePaymentAttemptResult {
  attempt!: PaymentAttemptResponse;
  /** true solo si ESTA llamada movió pending_review -> decision (invariante 5). */
  won!: boolean;
}
