import {
  BlockingWindow,
  CandidateTable,
  depositOutcomeOnCancel,
  isReservedNow,
  maxPartySize,
  overlaps,
  pickTable,
  slotsForDate,
} from './reservation-rules';

const at = (hhmm: string, date = '2026-10-16') => new Date(`${date}T${hhmm}:00-04:00`);

const TABLES: CandidateTable[] = [
  { id: 't2a', seats: 2, label: 'Mesa 1' },
  { id: 't2b', seats: 2, label: 'Mesa 2' },
  { id: 't4', seats: 4, label: 'Mesa 3' },
  { id: 't6', seats: 6, label: 'Mesa 4' },
];

const window = (tableId: string, from: string, to: string): BlockingWindow => ({
  tableId,
  startsAt: at(from),
  blocksUntil: at(to),
});

describe('slotsForDate', () => {
  const settings = {
    slotMinutes: 30,
    minLeadMinutes: 30,
    maxDaysAhead: 14,
    lastSlotBeforeCloseMinutes: 60,
  };

  it('genera horarios cada 30 min desde la apertura hasta una hora antes del cierre', () => {
    const slots = slotsForDate({
      date: '2026-10-16',
      now: at('08:00', '2026-10-15'),
      opensAtMinute: 12 * 60,
      closesAtMinute: 23 * 60,
      settings,
    });
    expect(slots[0]).toEqual(at('12:00'));
    expect(slots[slots.length - 1]).toEqual(at('22:00'));
    expect(slots).toHaveLength(21);
  });

  it('descarta horarios con menos de 30 min de anticipación', () => {
    const slots = slotsForDate({
      date: '2026-10-16',
      now: at('13:10'),
      opensAtMinute: 12 * 60,
      closesAtMinute: 23 * 60,
      settings,
    });
    // 13:30 ya no (faltan 20 min); 13:40 sería el primero posible y no existe: 14:00.
    expect(slots[0]).toEqual(at('14:00'));
  });

  it('un horario justo a 30 min de anticipación sí entra', () => {
    const slots = slotsForDate({
      date: '2026-10-16',
      now: at('13:00'),
      opensAtMinute: 12 * 60,
      closesAtMinute: 23 * 60,
      settings,
    });
    expect(slots[0]).toEqual(at('13:30'));
  });

  it('no ofrece días más allá del máximo', () => {
    const slots = slotsForDate({
      date: '2026-11-30',
      now: at('08:00', '2026-10-15'),
      opensAtMinute: 12 * 60,
      closesAtMinute: 23 * 60,
      settings,
    });
    expect(slots).toEqual([]);
  });

  it('una fecha inválida no devuelve horarios', () => {
    expect(
      slotsForDate({
        date: 'mañana',
        now: at('08:00'),
        opensAtMinute: 720,
        closesAtMinute: 1380,
        settings,
      }),
    ).toEqual([]);
  });
});

describe('pickTable', () => {
  const base = {
    tables: TABLES,
    startsAt: at('20:00'),
    blocksUntil: at('22:00'),
    maxOccupancyPercent: 90,
  };

  it('para 2 personas elige una mesa de 2 antes que una más grande', () => {
    expect(pickTable({ ...base, windows: [], partySize: 2 })?.seats).toBe(2);
  });

  it('para 3 personas usa la de 4 (la más chica que alcance)', () => {
    expect(pickTable({ ...base, windows: [], partySize: 3 })?.id).toBe('t4');
  });

  it('si las de 2 están tomadas, para 2 personas usa una más grande', () => {
    const windows = [window('t2a', '19:00', '21:00'), window('t2b', '20:30', '22:30')];
    expect(pickTable({ ...base, windows, partySize: 2 })?.id).toBe('t4');
  });

  it('una reserva que termina justo cuando empieza la otra no se pisa', () => {
    const windows = [window('t2a', '18:00', '20:00')];
    expect(pickTable({ ...base, windows, partySize: 2 })?.id).toBe('t2a');
  });

  it('no hay mesa para más personas que sillas', () => {
    expect(pickTable({ ...base, windows: [], partySize: 7 })).toBeNull();
  });

  it('respeta el tope de ocupación: con 4 mesas y 90% se pueden tomar 3', () => {
    const windows = [
      window('t2a', '20:00', '22:00'),
      window('t2b', '20:00', '22:00'),
      window('t4', '20:00', '22:00'),
    ];
    // Queda libre la de 6, pero ya hay 3 de 4 tomadas (tope = floor(4*0.9) = 3).
    expect(pickTable({ ...base, windows, partySize: 2 })).toBeNull();
  });

  it('el tope no bloquea cuando todavía hay margen', () => {
    const windows = [window('t2a', '20:00', '22:00'), window('t2b', '20:00', '22:00')];
    expect(pickTable({ ...base, windows, partySize: 2 })?.id).toBe('t4');
  });

  it('las mesas ocupadas por clientes sin reserva cuentan como tomadas', () => {
    const busyTableIds = new Set(['t2a', 't2b', 't4']);
    expect(pickTable({ ...base, windows: [], partySize: 2, busyTableIds })).toBeNull();
  });

  it('con una sola mesa el tope nunca la bloquea del todo', () => {
    const single = [{ id: 'solo', seats: 4, label: 'Mesa 1' }];
    expect(pickTable({ ...base, tables: single, windows: [], partySize: 2 })?.id).toBe('solo');
  });

  it('sin mesas no hay nada que ofrecer', () => {
    expect(pickTable({ ...base, tables: [], windows: [], partySize: 2 })).toBeNull();
  });
});

describe('depositOutcomeOnCancel', () => {
  const startsAt = at('20:00');

  it('cancelar con 4 horas o más devuelve el adelanto', () => {
    expect(depositOutcomeOnCancel(at('16:00'), startsAt, 4)).toBe('refund_due');
    expect(depositOutcomeOnCancel(at('10:00'), startsAt, 4)).toBe('refund_due');
  });

  it('cancelar con menos de 4 horas lo pierde', () => {
    expect(depositOutcomeOnCancel(at('16:01'), startsAt, 4)).toBe('forfeited');
    expect(depositOutcomeOnCancel(at('19:59'), startsAt, 4)).toBe('forfeited');
  });
});

describe('isReservedNow', () => {
  it('pesa desde un rato antes hasta que vence la espera', () => {
    const starts = at('20:00');
    const expires = at('20:30');
    expect(isReservedNow(at('19:20'), starts, expires, 30)).toBe(false);
    expect(isReservedNow(at('19:30'), starts, expires, 30)).toBe(true);
    expect(isReservedNow(at('20:30'), starts, expires, 30)).toBe(true);
    expect(isReservedNow(at('20:31'), starts, expires, 30)).toBe(false);
  });
});

describe('helpers', () => {
  it('maxPartySize es la mesa más grande', () => {
    expect(maxPartySize(TABLES)).toBe(6);
    expect(maxPartySize([])).toBe(0);
  });

  it('overlaps trata los bordes como no solapados', () => {
    expect(overlaps(at('10:00'), at('12:00'), at('12:00'), at('14:00'))).toBe(false);
    expect(overlaps(at('10:00'), at('12:01'), at('12:00'), at('14:00'))).toBe(true);
  });
});
