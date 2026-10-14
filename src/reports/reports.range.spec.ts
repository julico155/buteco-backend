import { ValidationError } from '../common/exceptions/domain-exception';
import {
  addDays,
  parseGroupBy,
  parsePagination,
  parseSalesFilters,
  resolveDateRange,
} from './reports.range';

// 2026-09-18 15:00 UTC = 11:00 en Bolivia (mismo día calendario).
const NOW = new Date('2026-09-18T15:00:00Z');

describe('resolveDateRange', () => {
  it('convierte fechas de Bolivia a rango UTC [from 00:00-04, to+1 00:00-04)', () => {
    const r = resolveDateRange('2026-09-10', '2026-09-12', NOW);
    expect(r.start.toISOString()).toBe('2026-09-10T04:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-09-13T04:00:00.000Z');
  });

  it('sin fechas devuelve los últimos 30 días hasta hoy en Bolivia', () => {
    const r = resolveDateRange(undefined, undefined, NOW);
    expect(r.start.toISOString()).toBe('2026-08-20T04:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-09-19T04:00:00.000Z');
  });

  it('a las 02:00 UTC todavía es el día anterior en Bolivia', () => {
    const r = resolveDateRange(undefined, undefined, new Date('2026-09-18T02:00:00Z'));
    expect(r.end.toISOString()).toBe('2026-09-18T04:00:00.000Z');
  });

  it('rechaza formato inválido y fechas imposibles', () => {
    expect(() => resolveDateRange('18/09/2026', undefined, NOW)).toThrow(ValidationError);
    expect(() => resolveDateRange('2026-02-30', undefined, NOW)).toThrow(ValidationError);
  });

  it('rechaza from posterior a to y rangos de más de un año', () => {
    expect(() => resolveDateRange('2026-09-12', '2026-09-10', NOW)).toThrow(ValidationError);
    expect(() => resolveDateRange('2025-01-01', '2026-09-10', NOW)).toThrow(ValidationError);
  });
});

describe('addDays', () => {
  it('cruza fin de mes y de año', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('parseSalesFilters', () => {
  it('con session_id y sin fechas no acota por fecha', () => {
    const f = parseSalesFilters({ session_id: '3f2b8d1e-6c1a-4f4e-9d2b-0a1b2c3d4e5f' }, NOW);
    expect(f.range).toBeNull();
    expect(f.sessionId).toBe('3f2b8d1e-6c1a-4f4e-9d2b-0a1b2c3d4e5f');
  });

  it('mapea filtros snake_case y valida enums', () => {
    const f = parseSalesFilters(
      { channel: 'pos', payment_method: 'qr', payment_status: 'paid', delivery_type: 'pickup', sold: 'true' },
      NOW,
    );
    expect(f).toMatchObject({
      channel: 'pos',
      paymentMethod: 'qr',
      paymentStatus: 'paid',
      deliveryType: 'pickup',
      sold: true,
    });
    expect(parseSalesFilters({ delivery_type: 'dine_in' }, NOW).deliveryType).toBe('dine_in');
    expect(() => parseSalesFilters({ delivery_type: 'mesa' }, NOW)).toThrow(ValidationError);
    expect(() => parseSalesFilters({ channel: 'telegram' }, NOW)).toThrow(ValidationError);
    expect(() => parseSalesFilters({ sold: 'si' }, NOW)).toThrow(ValidationError);
    expect(() => parseSalesFilters({ session_id: 'no-es-uuid' }, NOW)).toThrow(ValidationError);
  });
});

describe('parsePagination / parseGroupBy', () => {
  it('aplica defaults y tope', () => {
    expect(parsePagination(undefined, undefined)).toEqual({ limit: 50, offset: 0 });
    expect(parsePagination('999', '10')).toEqual({ limit: 200, offset: 10 });
    expect(() => parsePagination('-1', undefined)).toThrow(ValidationError);
    expect(() => parsePagination('abc', undefined)).toThrow(ValidationError);
  });

  it('group_by acepta day/hour y defaultea a day', () => {
    expect(parseGroupBy(undefined)).toBe('day');
    expect(parseGroupBy('hour')).toBe('hour');
    expect(() => parseGroupBy('week')).toThrow(ValidationError);
  });
});
