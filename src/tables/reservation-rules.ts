import { startOfBoliviaDay } from '../common/time/service-window';

/** Reglas puras de reservas: sin base de datos, para poder probarlas a fondo. */

export interface ReservationTimingSettings {
  slotMinutes: number;
  blockMinutes: number;
  holdMinutes: number;
  minLeadMinutes: number;
  maxDaysAhead: number;
  lastSlotBeforeCloseMinutes: number;
  cancelRefundHours: number;
  maxPeoplePerDay: number;
}

/**
 * Horarios (inicio exacto) en que se puede reservar un día: desde la apertura
 * hasta `lastSlotBeforeCloseMinutes` antes del cierre, cada `slotMinutes`.
 * Devuelve los instantes UTC. Aplica el anticipo mínimo y el máximo de días.
 */
export function slotsForDate(params: {
  date: string;
  now: Date;
  opensAtMinute: number;
  closesAtMinute: number;
  settings: Pick<
    ReservationTimingSettings,
    'slotMinutes' | 'minLeadMinutes' | 'maxDaysAhead' | 'lastSlotBeforeCloseMinutes'
  >;
}): Date[] {
  const { date, now, opensAtMinute, closesAtMinute, settings } = params;
  const dayStart = startOfBoliviaDay(date);
  if (Number.isNaN(dayStart.getTime())) return [];

  const earliest = now.getTime() + settings.minLeadMinutes * 60_000;
  const latestDay = now.getTime() + settings.maxDaysAhead * 24 * 60 * 60_000;
  const lastMinute = closesAtMinute - settings.lastSlotBeforeCloseMinutes;

  const slots: Date[] = [];
  for (let minute = opensAtMinute; minute <= lastMinute; minute += settings.slotMinutes) {
    const instant = new Date(dayStart.getTime() + minute * 60_000);
    if (instant.getTime() < earliest) continue;
    if (instant.getTime() > latestDay) continue;
    slots.push(instant);
  }
  return slots;
}

/**
 * Cupo del día: ¿entra un grupo más sin pasar el máximo de personas con reserva?
 * `reservedPeople` es la suma de `party_size` de las reservas vivas de ese día (sin contar el grupo nuevo).
 * Justo en el tope entra; un solo comensal de más, no.
 */
export function fitsInDay(params: {
  reservedPeople: number;
  partySize: number;
  maxPeoplePerDay: number;
}): boolean {
  const { reservedPeople, partySize, maxPeoplePerDay } = params;
  if (!Number.isInteger(partySize) || partySize < 1) return false;
  return reservedPeople + partySize <= maxPeoplePerDay;
}

/** Cuántas personas más se pueden reservar ese día (nunca negativo). */
export function remainingPeople(reservedPeople: number, maxPeoplePerDay: number): number {
  return Math.max(0, maxPeoplePerDay - reservedPeople);
}

export type DepositOutcome = 'refund_due' | 'forfeited';

/** Cancelar con anticipación devuelve el adelanto; tarde, se pierde. */
export function depositOutcomeOnCancel(
  now: Date,
  startsAt: Date,
  cancelRefundHours: number,
): DepositOutcome {
  const limit = startsAt.getTime() - cancelRefundHours * 60 * 60_000;
  return now.getTime() <= limit ? 'refund_due' : 'forfeited';
}

/**
 * Crédito que el adelanto de una reserva deja en el pedido de consumo: lo que pagó, sin pasar de lo que se consumió. Lo que
 * sobra del adelanto no se devuelve ni queda a favor (por ahora no hay conciliación).
 */
export function depositCreditFor(depositAmount: number, consumptionSubtotal: number): number {
  const credit = Math.min(Math.max(depositAmount, 0), Math.max(consumptionSubtotal, 0));
  return Math.round(credit * 100) / 100;
}
