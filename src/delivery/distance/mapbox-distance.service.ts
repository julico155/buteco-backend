import { Logger } from '@nestjs/common';
import { Coordinates, DistanceResult, DistanceService, HaversineDistanceService } from './distance.service';

const MAPBOX_DIRECTIONS_URL = 'https://api.mapbox.com/directions/v5/mapbox/driving';
/** Presupuesto corto: si Mapbox no responde a tiempo, cae a línea recta en vez de bloquear el checkout. */
const REQUEST_TIMEOUT_MS = 4000;

interface MapboxDirectionsResponse {
  code: string;
  routes?: Array<{ distance: number }>;
}

/**
 * Distancia real de calle vía Mapbox Directions API (perfil 'driving').
 * Cualquier fallo (sin token, red, respuesta inesperada, timeout) degrada a
 * HaversineDistanceService en vez de tumbar la cotización — el
 * `distance_source` devuelto siempre refleja lo que realmente se usó.
 */
export class MapboxDistanceService implements DistanceService {
  private readonly logger = new Logger(MapboxDistanceService.name);
  private readonly fallback = new HaversineDistanceService();

  constructor(private readonly accessToken: string) {}

  async metersBetween(from: Coordinates, to: Coordinates): Promise<DistanceResult> {
    try {
      const meters = await this.fetchDrivingMeters(from, to);
      return { meters: Math.round(meters), source: 'mapbox' };
    } catch (error) {
      this.logger.warn(
        `Mapbox Directions falló, usando línea recta: ${(error as Error).message}`,
      );
      return this.fallback.metersBetween(from, to);
    }
  }

  private async fetchDrivingMeters(from: Coordinates, to: Coordinates): Promise<number> {
    const coordinates = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    const url = `${MAPBOX_DIRECTIONS_URL}/${coordinates}?alternatives=true&overview=false&access_token=${encodeURIComponent(this.accessToken)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = (await response.json()) as MapboxDirectionsResponse;
    const distances = (body.routes ?? [])
      .map((route) => route.distance)
      .filter((distance): distance is number => typeof distance === 'number' && Number.isFinite(distance));
    if (distances.length === 0) {
      throw new Error(`respuesta sin ruta válida (code=${body.code})`);
    }
    // Mapbox ordena las rutas por tiempo estimado, no por distancia — para
    // cobrar delivery nos importa el camino más corto, no el más rápido.
    return Math.min(...distances);
  }
}
