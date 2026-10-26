import {
  depositCreditFor,
  depositOutcomeOnCancel,
  fitsInDay,
  remainingPeople,
  slotsForDate,
} from './reservation-rules';

const at = (hhmm: string, date = '2026-10-16') => new Date(`${date}T${hhmm}:00-04:00`);

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


describe('fitsInDay (cupo de personas por día)', () => {
  const max = 30;

  it('con el día vacío entra cualquier grupo hasta el máximo', () => {
    expect(fitsInDay({ reservedPeople: 0, partySize: 4, maxPeoplePerDay: max })).toBe(true);
    expect(fitsInDay({ reservedPeople: 0, partySize: 30, maxPeoplePerDay: max })).toBe(true);
  });

  it('justo en el tope todavía entra', () => {
    expect(fitsInDay({ reservedPeople: 26, partySize: 4, maxPeoplePerDay: max })).toBe(true);
  });

  it('una persona de más ya no entra', () => {
    expect(fitsInDay({ reservedPeople: 27, partySize: 4, maxPeoplePerDay: max })).toBe(false);
    expect(fitsInDay({ reservedPeople: 30, partySize: 1, maxPeoplePerDay: max })).toBe(false);
  });

  it('un grupo mayor al máximo del día nunca entra', () => {
    expect(fitsInDay({ reservedPeople: 0, partySize: 31, maxPeoplePerDay: max })).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])('un tamaño de grupo inválido (%s) no entra', (partySize) => {
    expect(fitsInDay({ reservedPeople: 0, partySize, maxPeoplePerDay: max })).toBe(false);
  });

  it('el máximo sale del ajuste: con 10 personas, un grupo de 4 y otro de 7 no caben juntos', () => {
    expect(fitsInDay({ reservedPeople: 4, partySize: 6, maxPeoplePerDay: 10 })).toBe(true);
    expect(fitsInDay({ reservedPeople: 4, partySize: 7, maxPeoplePerDay: 10 })).toBe(false);
  });
});

describe('remainingPeople', () => {
  it('resta lo reservado del máximo y nunca baja de 0', () => {
    expect(remainingPeople(12, 30)).toBe(18);
    expect(remainingPeople(30, 30)).toBe(0);
    expect(remainingPeople(45, 30)).toBe(0);
  });
});

describe('depositCreditFor (adelanto como crédito en el pedido)', () => {
  it('si el consumo supera el adelanto, el crédito es todo el adelanto', () => {
    expect(depositCreditFor(100, 250)).toBe(100);
    expect(depositCreditFor(100, 100)).toBe(100);
  });

  it('si el consumo es menor, el crédito no pasa del consumo (lo que sobra no se devuelve ni queda a favor)', () => {
    expect(depositCreditFor(100, 80)).toBe(80);
  });

  it('sin adelanto o sin consumo no hay crédito, y nunca es negativo', () => {
    expect(depositCreditFor(0, 80)).toBe(0);
    expect(depositCreditFor(100, 0)).toBe(0);
    expect(depositCreditFor(-5, 80)).toBe(0);
    expect(depositCreditFor(100, -5)).toBe(0);
  });

  it('redondea al centavo', () => {
    expect(depositCreditFor(100, 33.335)).toBe(33.34);
  });
});
