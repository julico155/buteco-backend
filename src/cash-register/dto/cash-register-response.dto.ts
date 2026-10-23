import { ApiProperty } from '@nestjs/swagger';
import { CASH_REGISTER_SESSION_STATUS_VALUES } from '../../common/api-enums';
import { CashRegisterSessionStatus } from '../../database/types';

export class CashRegisterSessionResponse {
  id!: string;
  @ApiProperty({ enum: CASH_REGISTER_SESSION_STATUS_VALUES })
  status!: CashRegisterSessionStatus;
  openedAt!: string;
  openedBy!: string;
  openingAmount!: number;
  closedAt!: string | null;
  closedBy!: string | null;
  countedCashAmount!: number | null;
  expectedCashAmount!: number | null;
  cashDifference!: number | null;
  totalCashSalesAmount!: number | null;
  totalQrSalesAmount!: number | null;
  totalSalesAmount!: number | null;
  notes!: string | null;
}
