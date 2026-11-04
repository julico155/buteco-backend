import { ValidationError } from './exceptions/domain-exception';
import { catalogChannelOfOrder, resolveCatalogChannel } from './channel-visibility';

describe('resolveCatalogChannel', () => {
  it('fija whatsapp para el gateway aunque pida otro canal', () => {
    expect(resolveCatalogChannel('whatsapp-gateway')).toBe('whatsapp');
    expect(resolveCatalogChannel('whatsapp-gateway', 'pos')).toBe('whatsapp');
  });

  it('el staff sin ?channel ve todo', () => {
    expect(resolveCatalogChannel('pos')).toBeUndefined();
    expect(resolveCatalogChannel('pos', '')).toBeUndefined();
  });

  it('el staff puede pedir un canal concreto', () => {
    expect(resolveCatalogChannel('pos', 'pos')).toBe('pos');
    expect(resolveCatalogChannel('pos', 'whatsapp')).toBe('whatsapp');
  });

  it('rechaza un canal desconocido', () => {
    expect(() => resolveCatalogChannel('pos', 'telegram')).toThrow(ValidationError);
  });

  it('el canal web no filtra', () => {
    expect(resolveCatalogChannel('web')).toBeUndefined();
    expect(catalogChannelOfOrder('web')).toBeUndefined();
    expect(catalogChannelOfOrder('whatsapp')).toBe('whatsapp');
  });
});
