import { ApiProperty } from '@nestjs/swagger';
import {
  OrderStatus,
  ReservationDepositStatus,
  ReservationStatus,
  TableShape,
} from '../../database/types';
import {
  ORDER_STATUS_VALUES,
  RESERVATION_DEPOSIT_STATUS_VALUES,
  RESERVATION_STATUS_VALUES,
  TABLE_SHAPE_VALUES,
  TABLE_STATE_VALUES,
} from '../../common/api-enums';
import { PromotionComponentResponse } from '../../orders/dto/order-response.dto';
import { TableState } from '../table-state';

/**
 * Formas de las respuestas de mesas, cuentas y reservas. Son clases (no
 * interfaces) para que el generador de OpenAPI las lea: con interfaces cada
 * endpoint salía documentado como un objeto vacío y los clientes (POS, landing)
 * no recibían los campos al generar sus tipos.
 */

export class FloorResponse {
  id!: string;
  name!: string;
  sortOrder!: number;
  isActive!: boolean;
}

export class TableAccountSummary {
  orderId!: string;
  orderNumber!: string;
  @ApiProperty({ enum: ORDER_STATUS_VALUES })
  status!: OrderStatus;
  totalAmount!: number;
  itemsCount!: number;
  openedAt!: string;
  billRequestedAt!: string | null;
}

/** Reserva vigente sobre la mesa (la que la deja "reservada" en el plano). */
export class TableReservationSummary {
  reservationId!: string;
  reservationNumber!: string;
  customerName!: string;
  partySize!: number;
  startsAt!: string;
  status!: string;
}

export class TableResponse {
  id!: string;
  floorId!: string;
  label!: string;
  seats!: number;
  x!: number;
  y!: number;
  width!: number;
  height!: number;
  rotation!: number;
  @ApiProperty({ enum: TABLE_SHAPE_VALUES })
  shape!: TableShape;
  isActive!: boolean;
  /** Deducido de la cuenta viva; nunca se guarda. */
  @ApiProperty({ enum: TABLE_STATE_VALUES })
  state!: TableState;
  account!: TableAccountSummary | null;
  reservation!: TableReservationSummary | null;
}

/** Una línea anulada se sigue mostrando, marcada, pero no suma al total ni sale en la comanda. */
export class LineVoidInfo {
  voided!: boolean;
  voidedAt!: string | null;
  voidedBy!: string | null;
  voidReason!: string | null;
}

export class AccountItemOption {
  groupName!: string;
  optionName!: string;
  priceDelta!: number;
}

export class AccountRoundItem extends LineVoidInfo {
  id!: string;
  productName!: string;
  quantity!: number;
  subtotal!: number;
  excludedComplements!: string[];
  /** Solo cuando la línea tiene opciones elegidas (p. ej. las carnes de una tabla). */
  selectedOptions?: AccountItemOption[];
}

export class AccountRoundPromotion extends LineVoidInfo {
  id!: string;
  name!: string;
  comboQuantity!: number;
  subtotal!: number;
  components!: PromotionComponentResponse[];
}

export class AccountRound {
  roundNumber!: number;
  addedAt!: string;
  items!: AccountRoundItem[];
  promotions!: AccountRoundPromotion[];
}

export class TableAccountResponse {
  orderId!: string;
  orderNumber!: string;
  tableId!: string;
  tableLabel!: string;
  @ApiProperty({ enum: ORDER_STATUS_VALUES })
  status!: OrderStatus;
  paymentStatus!: string;
  paymentMethod!: string;
  /** Consumo de la cuenta, antes de descontar el adelanto de la reserva. */
  grossAmount!: number;
  /** Adelanto de reserva que se descuenta (0 si la mesa no venía de una reserva). */
  depositCreditAmount!: number;
  /** Lo que se cobra: consumo menos adelanto. Es el monto que ven QR, efectivo y split. */
  totalAmount!: number;
  openedAt!: string;
  billRequestedAt!: string | null;
  /** Nota del pedido (para la comanda). */
  notes!: string | null;
  /** Ronda más reciente: la que el POS imprime al sumar consumo. 0 si todavía no hay consumo. */
  latestRoundNumber!: number;
  rounds!: AccountRound[];
}

export class ReservationSettingsView {
  enabled!: boolean;
  depositAmount!: number;
  slotMinutes!: number;
  blockMinutes!: number;
  holdMinutes!: number;
  paymentTtlMinutes!: number;
  cancelRefundHours!: number;
  minLeadMinutes!: number;
  maxDaysAhead!: number;
  /** Tope de personas con reserva el mismo día (suma de los grupos). */
  maxPeoplePerDay!: number;
  lastSlotBeforeCloseMinutes!: number;
}

/** Lo que ve el cliente. */
export class PublicReservationResponse {
  id!: string;
  reservationNumber!: string;
  @ApiProperty({ enum: RESERVATION_STATUS_VALUES })
  status!: ReservationStatus;
  @ApiProperty({ enum: RESERVATION_DEPOSIT_STATUS_VALUES })
  depositStatus!: ReservationDepositStatus;
  partySize!: number;
  customerName!: string;
  startsAt!: string;
  /** Hasta cuándo se puede pagar (pending_payment) o llegar (confirmed). */
  expiresAt!: string;
  depositAmount!: number;
  /** Pedido con el QR del adelanto: la imagen sale de GET /orders/:id/qr-image. */
  depositOrderId!: string | null;
  notes!: string | null;
}

export class StaffReservationResponse extends PublicReservationResponse {
  customerPhone!: string;
  blocksUntil!: string;
  /** Pedido de consumo ("mesa") al que se aplicó el adelanto, cuando el cliente llegó. */
  accountOrderId!: string | null;
  cancelReason!: string | null;
}

export class AvailabilitySlot {
  startsAt!: string;
  time!: string;
}

export class AvailabilityResponse {
  date!: string;
  partySize!: number;
  maxPartySize!: number;
  depositAmount!: number;
  paymentTtlMinutes!: number;
  slots!: AvailabilitySlot[];
}
