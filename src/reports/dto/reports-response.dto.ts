import { ApiProperty } from '@nestjs/swagger';
import { PromotionComponentResponse, OrderItemSelectedOptionResponse } from '../../orders/dto/order-response.dto';
import { CashRegisterSessionResponse } from '../../cash-register/dto/cash-register-response.dto';

/** Formas de las respuestas de reportes. Son clases para que el OpenAPI las publique con sus campos. */

export class KpiSold {
  orders!: number;
  salesAmount!: number;
  averageTicket!: number;
}

export class KpiCancelled {
  orders!: number;
  rate!: number;
}

export class KpiUnpaid {
  orders!: number;
  amount!: number;
}

export class KpiBreakdown {
  key!: string;
  orders!: number;
  salesAmount!: number;
}

export class LateOrderRequestsKpi {
  total!: number;
  /** Cantidad por estado de la solicitud (pending, accepted, rejected, expired). */
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  byStatus!: Record<string, number>;
}

export class KpisResponse {
  totalOrders!: number;
  sold!: KpiSold;
  cancelled!: KpiCancelled;
  unpaid!: KpiUnpaid;
  byChannel!: KpiBreakdown[];
  byPaymentMethod!: KpiBreakdown[];
  byDeliveryType!: KpiBreakdown[];
  /** null si el reporte no tiene rango de fechas (se pidió por turno de caja). */
  lateOrderRequests!: LateOrderRequestsKpi | null;
}

export class TimeseriesPoint {
  bucket!: string;
  orders!: number;
  salesAmount!: number;
}

export class TimeseriesResponse {
  @ApiProperty({ enum: ['day', 'hour'] })
  groupBy!: 'day' | 'hour';
  timeZone!: string;
  points!: TimeseriesPoint[];
}

export class SalesListTotals {
  orders!: number;
  amount!: number;
}

export class SalesListItem {
  productNameSnapshot!: string;
  quantity!: number;
  subtotal!: number;
}

export class SalesListPromotion {
  promotionNameSnapshot!: string;
  comboQuantity!: number;
  subtotal!: number;
}

export class SalesListOrder {
  id!: string;
  orderNumber!: string;
  customerName!: string;
  channel!: string;
  deliveryType!: string;
  paymentMethod!: string;
  paymentStatus!: string;
  status!: string;
  totalAmount!: number;
  registerSessionId!: string | null;
  createdAt!: string | null;
  items!: SalesListItem[];
  promotions!: SalesListPromotion[];
}

export class SalesListResponse {
  totals!: SalesListTotals;
  limit!: number;
  offset!: number;
  orders!: SalesListOrder[];
}

export class ReportCustomer {
  id!: string;
  name!: string | null;
  phone!: string | null;
  email!: string | null;
}

export class ReportAmounts {
  subtotal!: number;
  deliveryBase!: number;
  deliverySurcharge!: number;
  total!: number;
}

export class ReportSplit {
  cashAmount!: number | null;
  qrAmount!: number | null;
  cashConfirmedAt!: string | null;
}

export class ReportDelivery {
  quoteStatus!: string | null;
  distanceMeters!: number | null;
  feePaid!: boolean | null;
  driverName!: string | null;
  acceptedAt!: string | null;
  deliveredAt!: string | null;
}

export class ReportTimestamps {
  createdAt!: string | null;
  confirmedAt!: string | null;
  cashConfirmedAt!: string | null;
  updatedAt!: string | null;
}

export class ReportOrderItem {
  productId!: string;
  productCodeSnapshot!: string;
  productNameSnapshot!: string;
  unitPriceSnapshot!: number;
  quantity!: number;
  subtotal!: number;
  excludedComplements!: string[];
  /** Solo cuando la línea tiene opciones elegidas. */
  selectedOptions?: OrderItemSelectedOptionResponse[];
}

export class ReportOrderPromotion {
  promotionId!: string | null;
  promotionNameSnapshot!: string;
  promoPriceSnapshot!: number;
  comboQuantity!: number;
  subtotal!: number;
  componentsSnapshot!: PromotionComponentResponse[];
}

export class ReportPaymentAttempt {
  id!: string;
  openedAs!: string;
  reviewStatus!: string;
  openedAt!: string | null;
  reviewedAt!: string | null;
}

export class ReportBankQrCharge {
  id!: string;
  paymentAttemptId!: string;
  qrId!: string;
  transactionId!: string;
  amount!: number;
  dueDate!: string;
  status!: string;
  createdAt!: string | null;
  updatedAt!: string | null;
}

export class OrderDetailResponse {
  id!: string;
  orderNumber!: string;
  channel!: string;
  deliveryType!: string;
  paymentMethod!: string;
  paymentStatus!: string;
  status!: string;
  notes!: string | null;
  customerName!: string;
  customer!: ReportCustomer | null;
  amounts!: ReportAmounts;
  /** Solo con paymentMethod='split'; en el resto, null. */
  split!: ReportSplit | null;
  delivery!: ReportDelivery;
  timestamps!: ReportTimestamps;
  statusUpdatedBy!: string | null;
  items!: ReportOrderItem[];
  promotions!: ReportOrderPromotion[];
  paymentAttempts!: ReportPaymentAttempt[];
  bankQrCharges!: ReportBankQrCharge[];
  cashRegisterSession!: CashRegisterSessionResponse | null;
}

export class TopProduct {
  productId!: string;
  name!: string;
  quantity!: number;
  revenue!: number;
}

export class TopCombo {
  promotionId!: string | null;
  name!: string;
  quantity!: number;
  revenue!: number;
}

export class TopCategory {
  categoryId!: string;
  name!: string;
  quantity!: number;
  revenue!: number;
}

export class TopProductsResponse {
  products!: TopProduct[];
  combos!: TopCombo[];
  categories!: TopCategory[];
}

export class CashSessionsResponse {
  limit!: number;
  offset!: number;
  sessions!: CashRegisterSessionResponse[];
}
