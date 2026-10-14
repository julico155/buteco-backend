import { DomainException, ValidationError } from '../common/exceptions/domain-exception';
import { resolveOrderChannel } from './order-channel';

describe('resolveOrderChannel', () => {
  it('el JWT de staff es pos y el token del agente es whatsapp', () => {
    expect(resolveOrderChannel('pos')).toBe('pos');
    expect(resolveOrderChannel('whatsapp-gateway')).toBe('whatsapp');
    expect(resolveOrderChannel('web')).toBe('web');
  });

  it('acepta un channel declarado que coincide con la credencial', () => {
    expect(resolveOrderChannel('pos', 'pos')).toBe('pos');
    expect(resolveOrderChannel('whatsapp-gateway', 'whatsapp')).toBe('whatsapp');
  });

  it('rechaza con 400 channel_mismatch si el body declara otro canal', () => {
    try {
      resolveOrderChannel('pos', 'whatsapp');
      fail('debía lanzar');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe('channel_mismatch');
      expect((error as DomainException).getStatus()).toBe(400);
    }
    expect(() => resolveOrderChannel('whatsapp-gateway', 'pos')).toThrow(DomainException);
  });

  it('rechaza un cliente de servicio sin canal asignado', () => {
    expect(() => resolveOrderChannel('otro-servicio')).toThrow(ValidationError);
  });
});
