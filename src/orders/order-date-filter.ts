import { ValidationError } from '../common/exceptions/domain-exception';
import { resolveDateRange } from '../reports/reports.range';

export interface OrderDateFilter {
  /** Inclusivo (UTC): inicio del primer día en La Paz. */
  createdFrom: Date;
  /** Exclusivo (UTC): inicio del día siguiente al último. */
  createdTo: Date;
}

/**
 * Filtro por fecha de `GET /orders`. Las fechas son días de Bolivia (YYYY-MM-DD),
 * ambas inclusivas.
 *  - `date`: un solo día (atajo de from = to).
 *  - `from` / `to`: rango; sin `to` = hoy, sin `from` = 30 días hasta `to`.
 *  - Ninguno: no se filtra por fecha (comportamiento de siempre).
 */
export function parseOrderDateFilter(
  query: { date?: string; from?: string; to?: string },
  now: Date = new Date(),
): OrderDateFilter | undefined {
  const { date, from, to } = query;
  if (date !== undefined && date !== '') {
    if (from || to) {
      throw new ValidationError('Usá date solo, o from/to; no las dos cosas.');
    }
    const range = resolveDateRange(date, date, now);
    return { createdFrom: range.start, createdTo: range.end };
  }
  if (!from && !to) return undefined;
  const range = resolveDateRange(from || undefined, to || undefined, now);
  return { createdFrom: range.start, createdTo: range.end };
}
