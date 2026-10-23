import { parseOrderDateFilter } from './order-date-filter';

// 2026-10-17 03:30 UTC = 2026-10-16 23:30 en La Paz.
const NOW = new Date('2026-10-17T03:30:00Z');

describe('parseOrderDateFilter', () => {
  it('sin parámetros no filtra por fecha', () => {
    expect(parseOrderDateFilter({}, NOW)).toBeUndefined();
    expect(parseOrderDateFilter({ date: '', from: '', to: '' }, NOW)).toBeUndefined();
  });

  it('date toma el día completo de La Paz (de 00:00 a 00:00 hora local)', () => {
    const filter = parseOrderDateFilter({ date: '2026-10-16' }, NOW)!;
    expect(filter.createdFrom.toISOString()).toBe('2026-10-16T04:00:00.000Z');
    expect(filter.createdTo.toISOString()).toBe('2026-10-17T04:00:00.000Z');
  });

  it('un pedido de las 23:03 hora local cae en el día local, no en el siguiente UTC', () => {
    const filter = parseOrderDateFilter({ date: '2026-10-16' }, NOW)!;
    const created = new Date('2026-10-17T03:03:00Z'); // 16-oct 23:03 en La Paz
    expect(created >= filter.createdFrom && created < filter.createdTo).toBe(true);
  });

  it('from y to son inclusivos', () => {
    const filter = parseOrderDateFilter({ from: '2026-10-14', to: '2026-10-16' }, NOW)!;
    expect(filter.createdFrom.toISOString()).toBe('2026-10-14T04:00:00.000Z');
    expect(filter.createdTo.toISOString()).toBe('2026-10-17T04:00:00.000Z');
  });

  it('solo from llega hasta hoy (hora de La Paz)', () => {
    const filter = parseOrderDateFilter({ from: '2026-10-15' }, NOW)!;
    expect(filter.createdTo.toISOString()).toBe('2026-10-17T04:00:00.000Z');
  });

  it('rechaza mezclar date con from/to', () => {
    expect(() => parseOrderDateFilter({ date: '2026-10-16', from: '2026-10-01' }, NOW)).toThrow();
  });

  it('rechaza fechas inválidas y rangos al revés', () => {
    expect(() => parseOrderDateFilter({ date: 'ayer' }, NOW)).toThrow();
    expect(() => parseOrderDateFilter({ from: '2026-10-16', to: '2026-10-01' }, NOW)).toThrow();
  });
});
