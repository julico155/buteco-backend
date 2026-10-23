import {
  BankQrChargeStatus,
  CashRegisterSessionStatus,
  DashboardUserRole,
  DeliveryQuoteStatus,
  LateOrderRequestStatus,
  OrderChannel,
  OrderDeliveryType,
  OrderPaymentMethod,
  OrderPaymentStatus,
  OrderStatus,
  PaymentAttemptReviewStatus,
  QrScope,
  ReservationDepositStatus,
  ReservationStatus,
  TableShape,
} from '../database/types';
import { TableState } from '../tables/table-state';

/**
 * Valores de los tipos-unión que aparecen en las respuestas de la API. El
 * generador de OpenAPI no puede leer un `type X = 'a' | 'b'` importado desde otro
 * archivo (lo publica como un objeto vacío), así que las clases de respuesta los
 * declaran con `@ApiProperty({ enum: ... })` usando estas listas.
 *
 * Cada lista tiene una comprobación de tipos: si se agrega un valor al tipo y
 * se olvida acá, no compila.
 */
type Missing<T extends string, A extends readonly string[]> = Exclude<T, A[number]>;
type Complete<T extends string, A extends readonly string[]> = [Missing<T, A>] extends [never]
  ? true
  : { faltan: Missing<T, A> };

export const ORDER_STATUS_VALUES = [
  'draft',
  'awaiting_location',
  'open',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
  'delivered',
  'cancelled',
] as const satisfies readonly OrderStatus[];
export const ORDER_CHANNEL_VALUES = ['whatsapp', 'web', 'pos', 'external'] as const satisfies readonly OrderChannel[];
export const ORDER_DELIVERY_TYPE_VALUES = ['delivery', 'pickup', 'dine_in'] as const satisfies readonly OrderDeliveryType[];
export const ORDER_PAYMENT_METHOD_VALUES = ['qr', 'cash', 'split'] as const satisfies readonly OrderPaymentMethod[];
export const ORDER_PAYMENT_STATUS_VALUES = [
  'unpaid',
  'pending_review',
  'paid',
  'rejected',
] as const satisfies readonly OrderPaymentStatus[];
export const QR_SCOPE_VALUES = ['food_only', 'food_and_delivery'] as const satisfies readonly QrScope[];
export const DELIVERY_QUOTE_STATUS_VALUES = [
  'pending',
  'quoted',
  'pending_manual',
  'failed',
] as const satisfies readonly DeliveryQuoteStatus[];
export const LATE_ORDER_REQUEST_STATUS_VALUES = [
  'pending',
  'accepted',
  'rejected',
  'expired',
] as const satisfies readonly LateOrderRequestStatus[];
export const PAYMENT_ATTEMPT_REVIEW_STATUS_VALUES = [
  'pending_review',
  'accepted',
  'rejected',
] as const satisfies readonly PaymentAttemptReviewStatus[];
export const BANK_QR_CHARGE_STATUS_VALUES = [
  'pending',
  'confirmed',
  'cancelled',
  'expired',
  'paid_unapplied',
  'refunded',
] as const satisfies readonly BankQrChargeStatus[];
export const CASH_REGISTER_SESSION_STATUS_VALUES = ['open', 'closed'] as const satisfies readonly CashRegisterSessionStatus[];
export const DASHBOARD_USER_ROLE_VALUES = ['admin', 'cashier'] as const satisfies readonly DashboardUserRole[];
export const TABLE_SHAPE_VALUES = ['square', 'round', 'rectangle'] as const satisfies readonly TableShape[];
export const TABLE_STATE_VALUES = [
  'free',
  'reserved',
  'occupied',
  'bill_requested',
  'out_of_service',
] as const satisfies readonly TableState[];
export const RESERVATION_STATUS_VALUES = [
  'pending_payment',
  'confirmed',
  'seated',
  'cancelled',
  'no_show',
  'expired',
] as const satisfies readonly ReservationStatus[];
export const RESERVATION_DEPOSIT_STATUS_VALUES = [
  'none',
  'pending',
  'paid',
  'refund_due',
  'refunded',
  'forfeited',
  'applied',
] as const satisfies readonly ReservationDepositStatus[];

// Falla al compilar si a algún tipo le falta un valor en su lista.
export const API_ENUMS_COMPLETE: [
  Complete<OrderStatus, typeof ORDER_STATUS_VALUES>,
  Complete<OrderChannel, typeof ORDER_CHANNEL_VALUES>,
  Complete<OrderDeliveryType, typeof ORDER_DELIVERY_TYPE_VALUES>,
  Complete<OrderPaymentMethod, typeof ORDER_PAYMENT_METHOD_VALUES>,
  Complete<OrderPaymentStatus, typeof ORDER_PAYMENT_STATUS_VALUES>,
  Complete<QrScope, typeof QR_SCOPE_VALUES>,
  Complete<DeliveryQuoteStatus, typeof DELIVERY_QUOTE_STATUS_VALUES>,
  Complete<LateOrderRequestStatus, typeof LATE_ORDER_REQUEST_STATUS_VALUES>,
  Complete<PaymentAttemptReviewStatus, typeof PAYMENT_ATTEMPT_REVIEW_STATUS_VALUES>,
  Complete<BankQrChargeStatus, typeof BANK_QR_CHARGE_STATUS_VALUES>,
  Complete<CashRegisterSessionStatus, typeof CASH_REGISTER_SESSION_STATUS_VALUES>,
  Complete<DashboardUserRole, typeof DASHBOARD_USER_ROLE_VALUES>,
  Complete<TableShape, typeof TABLE_SHAPE_VALUES>,
  Complete<TableState, typeof TABLE_STATE_VALUES>,
  Complete<ReservationStatus, typeof RESERVATION_STATUS_VALUES>,
  Complete<ReservationDepositStatus, typeof RESERVATION_DEPOSIT_STATUS_VALUES>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
