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
  maxOccupancyPercent: number;
}

export interface CandidateTable {
  id: string;
  seats: number;
  label: string;
}

export interface BlockingWindow {
  tableId: string;
  startsAt: Date;
  blocksUntil: Date;
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
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
 * Elige la mesa para una reserva: la más chica que alcance y que esté libre en
 * toda la ventana. Devuelve null si no hay, o si ocuparla pasaría el tope de
 * ocupación (`maxOccupancyPercent` de las mesas activas, medido en mesas).
 *
 * `busyTableIds` son mesas ocupadas ahora por clientes sin reserva: cuentan
 * como mesas tomadas y no se ofrecen.
 */
export function pickTable(params: {
  tables: CandidateTable[];
  windows: BlockingWindow[];
  startsAt: Date;
  blocksUntil: Date;
  partySize: number;
  maxOccupancyPercent: number;
  busyTableIds?: Set<string>;
}): CandidateTable | null {
  const { tables, windows, startsAt, blocksUntil, partySize, maxOccupancyPercent } = params;
  const busy = params.busyTableIds ?? new Set<string>();
  if (tables.length === 0) return null;

  const takenIds = new Set<string>(busy);
  for (const w of windows) {
    if (overlaps(startsAt, blocksUntil, w.startsAt, w.blocksUntil)) takenIds.add(w.tableId);
  }

  // Tope: nunca más de X% de las mesas tomadas a la vez en esa franja.
  const maxTaken = Math.max(1, Math.floor((tables.length * maxOccupancyPercent) / 100));
  if (takenIds.size >= maxTaken) return null;

  const candidates = tables
    .filter((t) => t.seats >= partySize && !takenIds.has(t.id))
    .sort((a, b) => a.seats - b.seats || a.label.localeCompare(b.label, 'es', { numeric: true }));
  return candidates[0] ?? null;
}

/** Cantidad máxima de personas que admite una reserva: las sillas de la mesa más grande. */
export function maxPartySize(tables: CandidateTable[]): number {
  return tables.reduce((max, t) => Math.max(max, t.seats), 0);
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
 * ¿La reserva ya "pesa" en el plano? Desde un rato antes de su hora hasta que
 * vence el plazo de espera.
 */
export function isReservedNow(
  now: Date,
  startsAt: Date,
  expiresAt: Date,
  showBeforeMinutes: number,
): boolean {
  const from = startsAt.getTime() - showBeforeMinutes * 60_000;
  return now.getTime() >= from && now.getTime() <= expiresAt.getTime();
}
