import { decideLocationAttach } from './location-attach';

const here = { latitude: -17.78, longitude: -63.18 };
// ~1,1 km al norte: claramente otra ubicación.
const far = { latitude: -17.77, longitude: -63.18 };
// ~2 m: dentro de la tolerancia de 5 m.
const nearby = { latitude: -17.78002, longitude: -63.18 };
// ~11 m: fuera de la tolerancia.
const tenMeters = { latitude: -17.7801, longitude: -63.18 };

const base = { status: 'awaiting_location', delivery_quote_status: 'pending' as string | null };
const withCoords = { delivery_latitude: here.latitude, delivery_longitude: here.longitude };
const noCoords = { delivery_latitude: null, delivery_longitude: null };

describe('decideLocationAttach', () => {
  it('sin ubicación y esperando ubicación: attach', () => {
    expect(decideLocationAttach({ ...base, ...noCoords }, here)).toBe('attach');
  });

  it('sin ubicación pero el pedido no espera ubicación: not_awaiting', () => {
    expect(
      decideLocationAttach({ status: 'confirmed', delivery_quote_status: 'quoted', ...noCoords }, here),
    ).toBe('not_awaiting');
  });

  it('misma ubicación ya cotizada (dentro de 5 m): already_attached', () => {
    const quoted = { status: 'confirmed', delivery_quote_status: 'quoted', ...withCoords };
    expect(decideLocationAttach(quoted, here)).toBe('already_attached');
    expect(decideLocationAttach(quoted, nearby)).toBe('already_attached');
  });

  it('misma ubicación con pending_manual: already_attached', () => {
    const pm = { status: 'awaiting_location', delivery_quote_status: 'pending_manual', ...withCoords };
    expect(decideLocationAttach(pm, here)).toBe('already_attached');
  });

  it('misma ubicación pero sin cotizar (pending/failed): se reintenta la cotización', () => {
    expect(decideLocationAttach({ ...base, ...withCoords }, here)).toBe('attach');
    expect(
      decideLocationAttach({ ...base, delivery_quote_status: 'failed', ...withCoords }, nearby),
    ).toBe('attach');
  });

  it('ubicación distinta antes de cotizar (pending o failed): replace', () => {
    expect(decideLocationAttach({ ...base, ...withCoords }, far)).toBe('replace');
    expect(
      decideLocationAttach({ ...base, delivery_quote_status: 'failed', ...withCoords }, far),
    ).toBe('replace');
  });

  it('a más de 5 m ya es otra ubicación', () => {
    expect(decideLocationAttach({ ...base, ...withCoords }, tenMeters)).toBe('replace');
    expect(
      decideLocationAttach(
        { status: 'confirmed', delivery_quote_status: 'quoted', ...withCoords },
        tenMeters,
      ),
    ).toBe('conflict');
  });

  it('ubicación distinta con el pedido cotizado: conflict', () => {
    expect(
      decideLocationAttach(
        { status: 'confirmed', delivery_quote_status: 'quoted', ...withCoords },
        far,
      ),
    ).toBe('conflict');
  });

  it('ubicación distinta con pending_manual: conflict', () => {
    expect(
      decideLocationAttach(
        { status: 'awaiting_location', delivery_quote_status: 'pending_manual', ...withCoords },
        far,
      ),
    ).toBe('conflict');
  });

  it('ubicación distinta con el pedido avanzado: conflict', () => {
    for (const status of ['preparing', 'ready', 'out_for_delivery']) {
      expect(
        decideLocationAttach({ status, delivery_quote_status: 'quoted', ...withCoords }, far),
      ).toBe('conflict');
    }
  });
});
