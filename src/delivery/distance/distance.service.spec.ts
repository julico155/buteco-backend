import { HaversineDistanceService } from './distance.service';

describe('HaversineDistanceService', () => {
  const service = new HaversineDistanceService();

  it('el mismo punto da 0 metros', async () => {
    const point = { latitude: -16.5, longitude: -68.15 };
    const result = await service.metersBetween(point, point);
    expect(result).toEqual({ meters: 0, source: 'straight_line' });
  });

  it('un grado de latitud son ~111.32 km (tolerancia 1%)', async () => {
    const a = { latitude: 0, longitude: 0 };
    const b = { latitude: 1, longitude: 0 };
    const { meters, source } = await service.metersBetween(a, b);
    expect(meters).toBeGreaterThan(111_320 * 0.99);
    expect(meters).toBeLessThan(111_320 * 1.01);
    expect(source).toBe('straight_line');
  });

  it('es simétrica', async () => {
    const a = { latitude: -16.5, longitude: -68.15 };
    const b = { latitude: -16.51, longitude: -68.12 };
    const ab = await service.metersBetween(a, b);
    const ba = await service.metersBetween(b, a);
    expect(ab.meters).toBe(ba.meters);
  });
});
