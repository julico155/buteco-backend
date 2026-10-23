import { ApiProperty } from '@nestjs/swagger';

export class TariffBandResponse {
  bandIndex!: number;
  maxDistanceMeters!: number;
  feeAmount!: number;
}

export class StandaloneQuoteResponse {
  id!: string;
  @ApiProperty({ enum: ['quoted', 'manual_quote', 'failed'] })
  status!: 'quoted' | 'manual_quote' | 'failed';
  distanceMeters!: number | null;
  /** Tarifa de la banda (sin recargo). */
  feeAmount!: number | null;
  /** Recargo por lluvia vigente al cotizar (0 si no hay). null si no hubo tarifa automática. */
  surchargeAmount!: number | null;
  /** feeAmount + surchargeAmount: el monto final real de delivery. null si no hubo tarifa automática. */
  totalAmount!: number | null;
  errorCode!: string | null;
}

export class OrderQuoteResponse {
  @ApiProperty({ enum: ['applied', 'already_applied', 'pending_manual'] })
  result!: 'applied' | 'already_applied' | 'pending_manual';
  orderId!: string;
  deliveryDistanceMeters!: number | null;
  deliveryBaseAmount!: number | null;
  deliverySurchargeAmount!: number | null;
  totalAmount!: number | null;
  status!: string;
  deliveryQuoteStatus!: string | null;
}
