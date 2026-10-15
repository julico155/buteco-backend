import { OrderDeliveryType } from '../../database/types';

/**
 * Horario semanal por tipo de servicio. Complementa al margen ancho de
 * `service-window.ts` (que decide con la caja): acá van los días que el local
 * abre y la hora límite para tomar pedidos de delivery y de recojo.
 *
 * Bolivia es UTC-4 todo el año (sin horario de verano), así que el día y la
 * hora local salen con aritmética directa, sin depender de Intl.
 */
const BOLIVIA_UTC_OFFSET_MS = -4 * 60 * 60 * 1000;

/** Domingo = 0 … sábado = 6 (igual que Date.getUTCDay). */
export interface WeeklySchedule {
  openWeekdays: number[];
  /** Minuto del día (0–1439) en que se abre a tomar pedidos. */
  opensAtMinute: number;
  /** Último minuto en que se acepta un pedido de delivery; null = sin tope propio. */
  deliveryLastOrderMinute: number | null;
  /** Último minuto en que se acepta un pedido de recojo; null = sin tope propio. */
  pickupLastOrderMinute: number | null;
}

export type ScheduleDecision =
  | { open: true }
  | {
      open: false;
      reason: 'closed_day' | 'before_opening' | 'after_last_order';
      serviceType: OrderDeliveryType;
    };

export function localWeekdayAndMinute(instant: Date): { weekday: number; minute: number } | null {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) return null;
  const local = new Date(ms + BOLIVIA_UTC_OFFSET_MS);
  return { weekday: local.getUTCDay(), minute: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/**
 * ¿Se puede tomar hoy, a esta hora, un pedido de este tipo de servicio?
 * Un instante ilegible sale cerrado: ante la duda no se toma un pedido que
 * nadie va a atender.
 */
export function checkSchedule(
  instant: Date,
  schedule: WeeklySchedule,
  serviceType: OrderDeliveryType,
): ScheduleDecision {
  const local = localWeekdayAndMinute(instant);
  if (!local) return { open: false, reason: 'closed_day', serviceType };

  if (!schedule.openWeekdays.includes(local.weekday)) {
    return { open: false, reason: 'closed_day', serviceType };
  }
  if (local.minute < schedule.opensAtMinute) {
    return { open: false, reason: 'before_opening', serviceType };
  }
  const lastOrderMinute =
    serviceType === 'delivery'
      ? schedule.deliveryLastOrderMinute
      : serviceType === 'pickup'
        ? schedule.pickupLastOrderMinute
        : null;
  if (lastOrderMinute !== null && local.minute > lastOrderMinute) {
    return { open: false, reason: 'after_last_order', serviceType };
  }
  return { open: true };
}

/** "22:50" -> 1370. null si no es una hora HH:MM válida. */
export function parseClockTime(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 1370 -> "22:50". */
export function formatClockTime(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
