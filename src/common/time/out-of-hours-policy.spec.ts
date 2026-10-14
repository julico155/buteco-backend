import { applyOutOfHoursPolicy, businessDayKey, CheckoutGate } from './service-window';

const LATE: CheckoutGate = { gate: 'late_review' };
const PROCEED: CheckoutGate = { gate: 'proceed' };
const CLOSED: CheckoutGate = { gate: 'closed' };

describe('applyOutOfHoursPolicy', () => {
  it('queue (default): encola igual que siempre', () => {
    expect(applyOutOfHoursPolicy(LATE, 'queue')).toEqual(LATE);
  });

  it('reject: un pedido sin caja se rechaza como cerrado', () => {
    expect(applyOutOfHoursPolicy(LATE, 'reject')).toEqual(CLOSED);
  });

  it('accept: un pedido sin caja se toma directo', () => {
    expect(applyOutOfHoursPolicy(LATE, 'accept')).toEqual(PROCEED);
  });

  it('proceed y closed nunca cambian, cualquiera sea la política', () => {
    for (const policy of ['queue', 'reject', 'accept'] as const) {
      expect(applyOutOfHoursPolicy(PROCEED, policy)).toEqual(PROCEED);
      expect(applyOutOfHoursPolicy(CLOSED, policy)).toEqual(CLOSED);
    }
  });
});

describe('businessDayKey', () => {
  // Bolivia es UTC-4: 23:00 UTC del 10 = 19:00 del 10 en La Paz.
  const at = (isoUtc: string) => new Date(isoUtc);

  it('un turno que cruza la medianoche (cierra 4am) cae en una sola fecha', () => {
    const evening = businessDayKey(at('2026-10-10T23:00:00Z'), 4); // 19:00 del 10
    const afterMidnight = businessDayKey(at('2026-10-11T05:00:00Z'), 4); // 01:00 del 11
    expect(afterMidnight).toBe(evening);
  });

  it('el turno siguiente es otra fecha', () => {
    const night1 = businessDayKey(at('2026-10-11T05:00:00Z'), 4); // 01:00 del 11
    const night2 = businessDayKey(at('2026-10-11T23:00:00Z'), 4); // 19:00 del 11
    expect(night2).not.toBe(night1);
  });

  it('un local que cierra de noche antes de medianoche: todo el turno comparte fecha', () => {
    const open = businessDayKey(at('2026-10-10T21:00:00Z'), 22); // 17:00
    const nearClose = businessDayKey(at('2026-10-11T01:30:00Z'), 22); // 21:30
    expect(nearClose).toBe(open);
  });
});
