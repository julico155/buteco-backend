import { HttpStatus } from '@nestjs/common';
import { Transaction } from 'kysely';
import { DomainException, NotFoundDomainError } from '../common/exceptions/domain-exception';
import { Database } from '../database/types';
import { depositCreditFor } from './reservation-rules';

/**
 * El adelanto de una reserva como crédito en el pedido de consumo ("mesa"). Funciones sobre la transacción del pedido (sin
 * inyección) para que `OrdersService` las use sin depender del módulo de reservas.
 *
 * Flujo: el cliente llega, el cajero crea el pedido "mesa" indicando la reserva; el pedido nace con el crédito (neto del
 * adelanto) y la reserva queda `seated` / adelanto `applied`, ambas cosas en la misma transacción que crea el pedido. Una
 * reserva se usa una sola vez: el bloqueo de la fila impide que dos pedidos le apliquen el mismo adelanto a la vez.
 */

export interface ReservationCredit {
  reservationId: string;
  /** Lo que el adelanto descuenta del consumo (0 si la reserva no llevaba adelanto). */
  credit: number;
  /** El adelanto realmente pagado: pasa a `applied` al crearse el pedido. */
  depositPaid: boolean;
}

/**
 * Bloquea la reserva y calcula el crédito sobre el consumo. Rechaza una reserva que no se puede usar: no pagó el adelanto,
 * ya se usó, se canceló, no se presentó a tiempo, o venció el plazo para llegar.
 */
export async function claimReservationCredit(
  trx: Transaction<Database>,
  reservationId: string,
  consumptionSubtotal: number,
  now: Date = new Date(),
): Promise<ReservationCredit> {
  const row = await trx
    .selectFrom('reservations')
    .select(['id', 'status', 'deposit_amount', 'deposit_status', 'deposit_order_id', 'expires_at'])
    .where('id', '=', reservationId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new NotFoundDomainError('reservation', reservationId);

  let status = row.status;
  let depositStatus = row.deposit_status;

  // El adelanto pudo entrar hace segundos y el proceso periódico todavía no confirmó la reserva: el pago manda.
  if (status === 'pending_payment' && row.deposit_order_id) {
    const deposit = await trx
      .selectFrom('orders')
      .select(['payment_status', 'status'])
      .where('id', '=', row.deposit_order_id)
      .executeTakeFirst();
    if (deposit?.payment_status === 'paid' && deposit.status !== 'cancelled') {
      status = 'confirmed';
      depositStatus = 'paid';
    }
  }

  if (status === 'seated') {
    throw new DomainException(
      'reservation_already_used',
      HttpStatus.CONFLICT,
      'Esta reserva ya se usó en otro pedido.',
    );
  }
  if (status !== 'confirmed') {
    throw new DomainException(
      'reservation_not_usable',
      HttpStatus.CONFLICT,
      status === 'pending_payment'
        ? 'La reserva todavía no pagó el adelanto.'
        : 'La reserva no está activa (cancelada, vencida o no presentada).',
      { status },
    );
  }
  if (new Date(row.expires_at).getTime() < now.getTime()) {
    throw new DomainException(
      'reservation_expired',
      HttpStatus.CONFLICT,
      'Pasó el plazo para llegar: la reserva perdió el adelanto.',
    );
  }

  const depositPaid = depositStatus === 'paid';
  return {
    reservationId,
    credit: depositPaid ? depositCreditFor(Number(row.deposit_amount), consumptionSubtotal) : 0,
    depositPaid,
  };
}

/** Marca la reserva como usada por este pedido. Va en la misma transacción que lo creó. */
export async function markReservationUsed(
  trx: Transaction<Database>,
  claim: ReservationCredit,
  orderId: string,
): Promise<void> {
  await trx
    .updateTable('reservations')
    .set({
      status: 'seated',
      ...(claim.depositPaid ? { deposit_status: 'applied' as const } : {}),
      account_order_id: orderId,
      updated_at: new Date(),
    })
    .where('id', '=', claim.reservationId)
    .execute();
}
