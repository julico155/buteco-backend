import { checkSchedule, formatClockTime, parseClockTime, WeeklySchedule } from './weekly-schedule';

// Martes a domingo, abre 12:00, delivery hasta 22:50 y recojo hasta 22:30.
const BUTECO: WeeklySchedule = {
  openWeekdays: [2, 3, 4, 5, 6, 0],
  opensAtMinute: 12 * 60,
  deliveryLastOrderMinute: 22 * 60 + 50,
  pickupLastOrderMinute: 22 * 60 + 30,
};

/** Instante UTC para una fecha/hora local de Bolivia (UTC-4). 2026-10-13 es martes. */
function at(localDate: string, hhmm: string): Date {
  return new Date(`${localDate}T${hhmm}:00-04:00`);
}

describe('checkSchedule', () => {
  it('rechaza todo el lunes (día de cierre)', () => {
    expect(checkSchedule(at('2026-10-12', '15:00'), BUTECO, 'delivery')).toMatchObject({
      open: false,
      reason: 'closed_day',
    });
    expect(checkSchedule(at('2026-10-12', '15:00'), BUTECO, 'pickup')).toMatchObject({
      open: false,
      reason: 'closed_day',
    });
  });

  it('abre martes a domingo', () => {
    for (const day of ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']) {
      expect(checkSchedule(at(day, '13:00'), BUTECO, 'delivery')).toEqual({ open: true });
    }
  });

  it('no toma pedidos antes de abrir', () => {
    expect(checkSchedule(at('2026-10-13', '11:59'), BUTECO, 'pickup')).toMatchObject({
      open: false,
      reason: 'before_opening',
    });
    expect(checkSchedule(at('2026-10-13', '12:00'), BUTECO, 'pickup')).toEqual({ open: true });
  });

  it('delivery se acepta hasta las 22:50 inclusive', () => {
    expect(checkSchedule(at('2026-10-13', '22:50'), BUTECO, 'delivery')).toEqual({ open: true });
    expect(checkSchedule(at('2026-10-13', '22:51'), BUTECO, 'delivery')).toMatchObject({
      open: false,
      reason: 'after_last_order',
    });
  });

  it('recojo se acepta hasta las 22:30 inclusive', () => {
    expect(checkSchedule(at('2026-10-13', '22:30'), BUTECO, 'pickup')).toEqual({ open: true });
    expect(checkSchedule(at('2026-10-13', '22:31'), BUTECO, 'pickup')).toMatchObject({
      open: false,
      reason: 'after_last_order',
    });
  });

  it('a las 22:40 el delivery entra pero el recojo no', () => {
    expect(checkSchedule(at('2026-10-13', '22:40'), BUTECO, 'delivery')).toEqual({ open: true });
    expect(checkSchedule(at('2026-10-13', '22:40'), BUTECO, 'pickup')).toMatchObject({ open: false });
  });

  it('mesa no tiene tope propio', () => {
    expect(checkSchedule(at('2026-10-13', '22:55'), BUTECO, 'dine_in')).toEqual({ open: true });
  });

  it('usa el día de Bolivia, no el UTC: martes 23:00 local ya es miércoles en UTC', () => {
    // 2026-10-13 23:30 Bolivia = 2026-10-14 03:30 UTC. Sigue siendo martes acá.
    expect(checkSchedule(at('2026-10-13', '23:30'), BUTECO, 'dine_in')).toEqual({ open: true });
    // Lunes 22:00 Bolivia = martes 02:00 UTC: tiene que seguir cerrado.
    expect(checkSchedule(at('2026-10-12', '22:00'), BUTECO, 'dine_in')).toMatchObject({
      open: false,
      reason: 'closed_day',
    });
  });

  it('un instante inválido sale cerrado', () => {
    expect(checkSchedule(new Date('nope'), BUTECO, 'delivery')).toMatchObject({ open: false });
  });
});

describe('clock helpers', () => {
  it('parsea y formatea HH:MM', () => {
    expect(parseClockTime('22:50')).toBe(1370);
    expect(parseClockTime('00:00')).toBe(0);
    expect(formatClockTime(1370)).toBe('22:50');
  });

  it('rechaza horas inválidas', () => {
    expect(parseClockTime('24:00')).toBeNull();
    expect(parseClockTime('9:5')).toBeNull();
    expect(parseClockTime('22:60')).toBeNull();
  });
});
