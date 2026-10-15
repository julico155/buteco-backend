import { OrderStatus } from '../database/types';

/**
 * Estado de una mesa en el plano. No se guarda: se deduce de su cuenta viva,
 * así nunca queda desincronizado.
 */
export type TableState = 'free' | 'reserved' | 'occupied' | 'bill_requested' | 'out_of_service';

export interface LiveAccountRef {
  status: OrderStatus;
  billRequestedAt: Date | string | null;
}

export function deriveTableState(params: {
  isActive: boolean;
  account: LiveAccountRef | null;
  /** Hay una reserva vigente (por llegar o dentro de su plazo de espera) y nadie sentado. */
  hasReservation?: boolean;
}): TableState {
  const { isActive, account, hasReservation = false } = params;
  // Una mesa con cuenta viva no se puede desactivar, pero por las dudas la
  // cuenta manda: nunca esconder plata pendiente detrás de "fuera de servicio".
  if (account) {
    // `confirmed` = cuenta ya cerrada con un cobro (QR) todavía pendiente.
    return account.billRequestedAt !== null || account.status === 'confirmed'
      ? 'bill_requested'
      : 'occupied';
  }
  if (!isActive) return 'out_of_service';
  return hasReservation ? 'reserved' : 'free';
}
