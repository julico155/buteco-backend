import { ApiProperty } from '@nestjs/swagger';
import { BalanceLedgerType, BalanceTopupStatus } from '../../database/types';

export const BALANCE_LEDGER_TYPE_VALUES: BalanceLedgerType[] = ['topup', 'commission', 'commission_reversal', 'adjustment'];
export const BALANCE_TOPUP_STATUS_VALUES: BalanceTopupStatus[] = ['pending', 'confirmed', 'expired', 'cancelled'];

export class BillingSummaryResponse {
  /** `false` = la comisión está apagada (AGENT_COMMISSION_PERCENT sin definir): no se cobra ni se bloquea nada. */
  enabled!: boolean;
  /** Saldo del libro (puede ser negativo, hasta el límite de sobregiro). */
  balance!: number;
  /** Comisión de los pedidos del agente abiertos y sin cobrar: todavía no se descontó. */
  reserved!: number;
  /** `balance - reserved`: lo que queda para pedidos nuevos. */
  available!: number;
  commissionPercent!: number;
  overdraftLimit!: number;
  lowBalanceThreshold!: number;
  /** Saldo en el umbral o por debajo: el POS muestra el aviso de recargar. */
  lowBalance!: boolean;
  /** `true` = el agente ya no toma pedidos nuevos hasta que se recargue. */
  suspended!: boolean;
  topupMinAmount!: number;
  /** `false` = faltan las llaves BANECO_TOPUP_*: no se pueden generar recargas. */
  topupConfigured!: boolean;
}

export class LedgerEntryResponse {
  id!: string;
  @ApiProperty({ enum: BALANCE_LEDGER_TYPE_VALUES })
  type!: BalanceLedgerType;
  /** Con signo: positivo suma, negativo resta. */
  amount!: number;
  orderId!: string | null;
  orderNumber!: string | null;
  topupId!: string | null;
  note!: string | null;
  createdBy!: string | null;
  createdAt!: string;
}

export class TopupResponse {
  id!: string;
  amount!: number;
  @ApiProperty({ enum: BALANCE_TOPUP_STATUS_VALUES })
  status!: BalanceTopupStatus;
  dueDate!: string;
  /** Ruta (con el mismo JWT) de la imagen del QR para pagar la recarga. */
  qrImageUrl!: string;
  createdAt!: string;
  paidAt!: string | null;
}
