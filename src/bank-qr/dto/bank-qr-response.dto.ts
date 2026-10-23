import { ApiProperty } from '@nestjs/swagger';
import { BANK_QR_CHARGE_STATUS_VALUES } from '../../common/api-enums';
import { BankQrChargeStatus } from '../../database/types';

export class QrChargeResponse {
  orderId!: string;
  @ApiProperty({ enum: BANK_QR_CHARGE_STATUS_VALUES })
  status!: BankQrChargeStatus;
  qrImageUrl!: string;
  dueDate!: string;
}

/** Un pago que el banco cobró y que ninguna caja recibió — espera decisión humana. */
export class UnappliedPaymentResponse {
  id!: string;
  orderId!: string;
  orderNumber!: string;
  customerName!: string;
  customerPhone!: string | null;
  qrId!: string;
  amount!: number;
  paidDetectedAt!: string | null;
  orderPaymentStatus!: string;
}
