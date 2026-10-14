import { checkoutGateAt, classifyServiceWindow } from './service-window';

const HOURS = { opensHour: 17, closesHour: 23 };

// Bolivia es UTC-4 fijo: hora local H = hora UTC - 4, o dicho al revés,
// para que sean las H en La Paz hay que usar UTC = H + 4.
function laPazTime(hour: number): Date {
  return new Date(Date.UTC(2026, 0, 15, hour + 4, 0, 0));
}

describe('classifyServiceWindow (margen ancho de cordura, horario 17-23)', () => {
  it('cerrado antes de las 17:00', () => {
    expect(classifyServiceWindow(laPazTime(10), HOURS)).toBe('closed');
    expect(classifyServiceWindow(laPazTime(16), HOURS)).toBe('closed');
  });

  it('abierto entre las 17:00 y las 23:00', () => {
    expect(classifyServiceWindow(laPazTime(17), HOURS)).toBe('open');
    expect(classifyServiceWindow(laPazTime(22), HOURS)).toBe('open');
  });

  it('cerrado desde las 23:00', () => {
    expect(classifyServiceWindow(laPazTime(23), HOURS)).toBe('closed');
    expect(classifyServiceWindow(laPazTime(0), HOURS)).toBe('closed');
  });

  it('un instante ilegible (NaN) sale closed, nunca abierto', () => {
    expect(classifyServiceWindow(new Date(NaN), HOURS)).toBe('closed');
  });
});

const OVERNIGHT_HOURS = { opensHour: 19, closesHour: 4 };

describe('classifyServiceWindow (margen cruzando medianoche, horario 19-4)', () => {
  it('cerrado antes de las 19:00', () => {
    expect(classifyServiceWindow(laPazTime(10), OVERNIGHT_HOURS)).toBe('closed');
    expect(classifyServiceWindow(laPazTime(18), OVERNIGHT_HOURS)).toBe('closed');
  });

  it('abierto desde las 19:00, incluyendo después de medianoche', () => {
    expect(classifyServiceWindow(laPazTime(19), OVERNIGHT_HOURS)).toBe('open');
    expect(classifyServiceWindow(laPazTime(23), OVERNIGHT_HOURS)).toBe('open');
    expect(classifyServiceWindow(laPazTime(0), OVERNIGHT_HOURS)).toBe('open');
    expect(classifyServiceWindow(laPazTime(3), OVERNIGHT_HOURS)).toBe('open');
  });

  it('cerrado desde las 4:00', () => {
    expect(classifyServiceWindow(laPazTime(4), OVERNIGHT_HOURS)).toBe('closed');
    expect(classifyServiceWindow(laPazTime(12), OVERNIGHT_HOURS)).toBe('closed');
  });
});

describe('checkoutGateAt (la caja decide adentro del margen horario)', () => {
  it('afuera del margen: closed sin importar la caja', () => {
    expect(checkoutGateAt(laPazTime(10), OVERNIGHT_HOURS, true)).toEqual({ gate: 'closed' });
    expect(checkoutGateAt(laPazTime(10), OVERNIGHT_HOURS, false)).toEqual({ gate: 'closed' });
  });

  it('adentro del margen con caja abierta: proceed', () => {
    expect(checkoutGateAt(laPazTime(20), OVERNIGHT_HOURS, true)).toEqual({ gate: 'proceed' });
  });

  it('adentro del margen sin caja abierta: late_review, aunque sea temprano en la noche', () => {
    // El cajero todavía no abrió — no importa que falten horas para el
    // cierre "oficial", si no hay caja el pedido se encola igual.
    expect(checkoutGateAt(laPazTime(20), OVERNIGHT_HOURS, false)).toEqual({ gate: 'late_review' });
  });

  it('cerraron la caja temprano: los pedidos posteriores se encolan aunque siga dentro del margen', () => {
    expect(checkoutGateAt(laPazTime(1), OVERNIGHT_HOURS, false)).toEqual({ gate: 'late_review' });
  });

  it('se quedaron abiertos hasta tarde: sigue proceed mientras la caja siga abierta', () => {
    expect(checkoutGateAt(laPazTime(3), OVERNIGHT_HOURS, true)).toEqual({ gate: 'proceed' });
  });
});
