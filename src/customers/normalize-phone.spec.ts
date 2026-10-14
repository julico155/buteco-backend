import { normalizePhone } from './normalize-phone';

describe('normalizePhone', () => {
  it('agrega solo el + cuando el número ya trae código de país', () => {
    expect(normalizePhone('59170001234')).toBe('+59170001234');
    expect(normalizePhone('+59170001234')).toBe('+59170001234');
  });

  it('quita espacios, guiones, puntos y paréntesis', () => {
    expect(normalizePhone('+591 7000-1234')).toBe('+59170001234');
    expect(normalizePhone(' 591 (700) 01.234 ')).toBe('+59170001234');
  });

  it('+591… y 591… terminan siendo el mismo valor', () => {
    expect(normalizePhone('591 70001234')).toBe(normalizePhone('+59170001234'));
  });

  it('no asume país: un número local queda tal cual, sin +', () => {
    expect(normalizePhone('70001234')).toBe('70001234');
    expect(normalizePhone('0987654321')).toBe('0987654321');
    expect(normalizePhone('2125551234')).toBe('2125551234');
  });

  it('con assumeInternational (wa_id de WhatsApp) agrega + aunque sea corto', () => {
    expect(normalizePhone('5354123456', { assumeInternational: true })).toBe('+5354123456');
    expect(normalizePhone('59170001234', { assumeInternational: true })).toBe('+59170001234');
  });

  it('el prefijo internacional 00 se convierte en +', () => {
    expect(normalizePhone('0059170001234')).toBe('+59170001234');
  });

  it('funciona con cualquier país, no solo Bolivia', () => {
    expect(normalizePhone('5491123456789')).toBe('+5491123456789');
    expect(normalizePhone('+34 612 345 678')).toBe('+34612345678');
  });

  it('valores no numéricos se devuelven sin formato, sin inventar nada', () => {
    expect(normalizePhone('  abc-def ')).toBe('abcdef');
    expect(normalizePhone('+')).toBe('+');
  });
});
