import { canonicalize, hashRequestBody } from './idempotency.service';

describe('hashRequestBody / canonicalize (invariante 2: idempotencia por contenido)', () => {
  it('produce el mismo hash sin importar el orden de las claves', () => {
    const a = { channel: 'pos', items: [{ productId: 'p1', quantity: 2 }], notes: null };
    const b = { notes: null, items: [{ quantity: 2, productId: 'p1' }], channel: 'pos' };
    expect(hashRequestBody(a)).toBe(hashRequestBody(b));
  });

  it('produce un hash distinto si cambia el contenido del carrito', () => {
    const a = { items: [{ productId: 'p1', quantity: 1 }] };
    const b = { items: [{ productId: 'p1', quantity: 2 }] };
    expect(hashRequestBody(a)).not.toBe(hashRequestBody(b));
  });

  it('distingue arrays de objetos (el orden de los items sí importa)', () => {
    const a = { items: ['a', 'b'] };
    const b = { items: ['b', 'a'] };
    expect(canonicalize(a)).not.toBe(canonicalize(b));
  });

  it('es determinístico para valores primitivos y null', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('x')).toBe('"x"');
  });
});
