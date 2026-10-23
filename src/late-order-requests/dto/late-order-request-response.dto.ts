import { ApiProperty } from '@nestjs/swagger';
import { LATE_ORDER_REQUEST_STATUS_VALUES } from '../../common/api-enums';

/** Pedido fuera de horario aceptado en espera (202) o ya resuelto (200): siempre el mismo estado. */
export class LateOrderRequestAcceptedResponse {
  requestId!: string;
  requestNumber!: string;
  @ApiProperty({ enum: LATE_ORDER_REQUEST_STATUS_VALUES })
  status!: 'pending' | 'accepted' | 'rejected' | 'expired';
  subtotalAmount!: number;
  expiresAt!: string;
  /** Solo cuando `status` es `accepted`: el pedido en que se convirtió. Ausentes en cualquier otro estado. */
  orderId?: string;
  orderNumber?: string;
}

export class LateOrderRequestResponse {
  id!: string;
  requestNumber!: string;
  customerId!: string | null;
  customerName!: string;
  @ApiProperty({ enum: LATE_ORDER_REQUEST_STATUS_VALUES })
  status!: string;
  subtotalAmount!: number;
  requestedAt!: string;
  expiresAt!: string;
  orderId!: string | null;
}
