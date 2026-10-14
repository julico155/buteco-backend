import { MapboxDistanceService } from './mapbox-distance.service';

describe('MapboxDistanceService', () => {
  const from = { latitude: -16.5, longitude: -68.15 };
  const to = { latitude: -16.51, longitude: -68.12 };
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('usa la distancia de ruta de Mapbox cuando la API responde bien', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'Ok', routes: [{ distance: 4321.7 }] }),
    }) as unknown as typeof fetch;

    const service = new MapboxDistanceService('fake-token');
    const result = await service.metersBetween(from, to);

    expect(result).toEqual({ meters: 4322, source: 'mapbox' });
  });

  it('con varias alternativas, elige la de menor distancia (no la primera/más rápida)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [{ distance: 5000 }, { distance: 3500 }, { distance: 4200 }],
      }),
    }) as unknown as typeof fetch;

    const service = new MapboxDistanceService('fake-token');
    const result = await service.metersBetween(from, to);

    expect(result).toEqual({ meters: 3500, source: 'mapbox' });
  });

  it('cae a línea recta si Mapbox responde con error HTTP', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;

    const service = new MapboxDistanceService('bad-token');
    const result = await service.metersBetween(from, to);

    expect(result.source).toBe('straight_line');
    expect(result.meters).toBeGreaterThan(0);
  });

  it('cae a línea recta si Mapbox no devuelve una ruta válida', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'NoRoute', routes: [] }),
    }) as unknown as typeof fetch;

    const service = new MapboxDistanceService('fake-token');
    const result = await service.metersBetween(from, to);

    expect(result.source).toBe('straight_line');
  });

  it('cae a línea recta si fetch rechaza (red caída)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const service = new MapboxDistanceService('fake-token');
    const result = await service.metersBetween(from, to);

    expect(result.source).toBe('straight_line');
  });
});
