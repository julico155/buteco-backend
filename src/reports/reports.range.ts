import { ValidationError } from '../common/exceptions/domain-exception';
import { dateInBolivia, startOfBoliviaDay } from '../common/time/service-window';
import {
  OrderChannel,
  OrderDeliveryType,
  OrderPaymentMethod,
  OrderPaymentStatus,
  OrderStatus,
} from '../database/types';

export interface DateRange {
  /** Inclusivo. */
  start: Date;
  /** Exclusivo. */
  end: Date;
}

export interface SalesFilters {
  /** null solo cuando se filtra por turno de caja y no se pidieron fechas. */
  range: DateRange | null;
  sessionId?: string;
  channel?: OrderChannel;
  paymentMethod?: OrderPaymentMethod;
  paymentStatus?: OrderPaymentStatus;
  status?: OrderStatus;
  deliveryType?: OrderDeliveryType;
  /** Atajo: solo pedidos vendidos (pagados y no cancelados). */
  sold: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SPAN_DAYS = 30;
const MAX_SPAN_DAYS = 366;

const CHANNELS: readonly OrderChannel[] = ['whatsapp', 'web', 'pos', 'external'];
const DELIVERY_TYPES: readonly OrderDeliveryType[] = ['delivery', 'pickup', 'dine_in'];
const PAYMENT_METHODS: readonly OrderPaymentMethod[] = ['qr', 'cash'];
const PAYMENT_STATUSES: readonly OrderPaymentStatus[] = ['unpaid', 'pending_review', 'paid', 'rejected'];
const ORDER_STATUSES: readonly OrderStatus[] = [
  'draft',
  'awaiting_location',
  'open',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
  'delivered',
  'cancelled',
];

function assertDate(value: string, name: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !DATE_RE.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new ValidationError(`${name} debe ser una fecha válida con formato YYYY-MM-DD.`);
  }
  return value;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * `from`/`to` son fechas de Bolivia, ambas inclusivas. Sin `to` = hoy; sin
 * `from` = 30 días hasta `to`. Devuelve el rango UTC [inicio del `from`,
 * inicio del día siguiente a `to`).
 */
export function resolveDateRange(
  from: string | undefined,
  to: string | undefined,
  now: Date = new Date(),
): DateRange {
  const toDate = to ? assertDate(to, 'to') : dateInBolivia(now);
  const fromDate = from ? assertDate(from, 'from') : addDays(toDate, -(DEFAULT_SPAN_DAYS - 1));
  if (fromDate > toDate) {
    throw new ValidationError('from no puede ser posterior a to.');
  }
  const spanDays = (Date.parse(toDate) - Date.parse(fromDate)) / DAY_MS + 1;
  if (spanDays > MAX_SPAN_DAYS) {
    throw new ValidationError(`El rango máximo es de ${MAX_SPAN_DAYS} días.`);
  }
  return { start: startOfBoliviaDay(fromDate), end: startOfBoliviaDay(addDays(toDate, 1)) };
}

function pickEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${name} debe ser uno de: ${allowed.join(', ')}.`);
  }
  return value as T;
}

export function parseSalesFilters(
  query: Record<string, string | undefined>,
  now: Date = new Date(),
): SalesFilters {
  const sessionId = query.session_id || undefined;
  if (sessionId !== undefined && !UUID_RE.test(sessionId)) {
    throw new ValidationError('session_id debe ser un UUID.');
  }
  // Con turno de caja y sin fechas no se acota por fecha: el turno ya es el rango.
  const range =
    sessionId && !query.from && !query.to ? null : resolveDateRange(query.from, query.to, now);

  let sold = false;
  if (query.sold !== undefined && query.sold !== '') {
    if (query.sold !== 'true' && query.sold !== 'false') {
      throw new ValidationError('sold debe ser true o false.');
    }
    sold = query.sold === 'true';
  }

  return {
    range,
    sessionId,
    channel: pickEnum(query.channel, CHANNELS, 'channel'),
    paymentMethod: pickEnum(query.payment_method, PAYMENT_METHODS, 'payment_method'),
    paymentStatus: pickEnum(query.payment_status, PAYMENT_STATUSES, 'payment_status'),
    status: pickEnum(query.status, ORDER_STATUSES, 'status'),
    deliveryType: pickEnum(query.delivery_type, DELIVERY_TYPES, 'delivery_type'),
    sold,
  };
}

function parseNonNegativeInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError(`${name} debe ser un entero mayor o igual a 0.`);
  }
  return n;
}

export function parsePagination(
  limit: string | undefined,
  offset: string | undefined,
  defaultLimit = 50,
  maxLimit = 200,
): { limit: number; offset: number } {
  const parsedLimit = parseNonNegativeInt(limit, 'limit');
  return {
    limit: Math.min(Math.max(parsedLimit ?? defaultLimit, 1), maxLimit),
    offset: parseNonNegativeInt(offset, 'offset') ?? 0,
  };
}

export function parseGroupBy(value: string | undefined): 'day' | 'hour' {
  if (value === undefined || value === '') return 'day';
  if (value !== 'day' && value !== 'hour') {
    throw new ValidationError('group_by debe ser day u hour.');
  }
  return value;
}
