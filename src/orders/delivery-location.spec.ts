import { DomainException } from '../common/exceptions/domain-exception';
import { hashRequestBody } from '../common/idempotency/idempotency.service';
import {
  assertDeliveryLocationForWrite,
  assertWebDeliveryLocation,
  canSendDeliveryLocation,
  idempotencyBody,
  sameDeliveryLocation,
} from './delivery-location';

/** NO se ha ejecutado todavía. Reglas puras: qué SERVICIO autenticado puede mandar una ubicación al crear un pedido. */
const point = { latitude: -17.7833, longitude: -63.1821 };

function failure(run: () => unknown): DomainException {
  try {
    run();
  } catch (error) {
    return error as DomainException;
  }
  throw new Error('debía lanzar');
}

/** Servicio autenticado → canal que produce su credencial (ver `CHANNEL_BY_API_CLIENT`). */
const WEB = { apiClient: 'web', channel: 'web' } as const;
const GATEWAY = { apiClient: 'whatsapp-gateway', channel: 'whatsapp' } as const;
const delivery = { deliveryType: 'delivery' } as const;

describe('assertWebDeliveryLocation', () => {
  it('sin ubicación devuelve null para cualquier servicio y canal: los clientes anteriores no cambian', () => {
    for (const [apiClient, channel] of [['web', 'web'], ['whatsapp-gateway', 'whatsapp'], ['pos', 'pos'], ['external', 'external']] as const) {
      for (const deliveryType of ['delivery', 'pickup', 'dine_in'] as const) {
        expect(assertWebDeliveryLocation({ apiClient, channel, deliveryType, location: undefined })).toBeNull();
        expect(assertWebDeliveryLocation({ apiClient, channel, deliveryType, location: null })).toBeNull();
      }
    }
  });

  it('1. credencial web + delivery + coordenadas válidas: devuelve la ubicación', () => {
    expect(assertWebDeliveryLocation({ ...WEB, ...delivery, location: point })).toEqual(point);
  });

  it('2. whatsapp-gateway + delivery + coordenadas válidas: devuelve la ubicación (su canal sigue siendo whatsapp)', () => {
    expect(assertWebDeliveryLocation({ ...GATEWAY, ...delivery, location: point })).toEqual(point);
  });

  it('acepta los extremos del rango geográfico', () => {
    for (const principal of [WEB, GATEWAY]) {
      expect(assertWebDeliveryLocation({ ...principal, ...delivery, location: { latitude: 90, longitude: 180 } })).not.toBeNull();
      expect(assertWebDeliveryLocation({ ...principal, ...delivery, location: { latitude: -90, longitude: -180 } })).not.toBeNull();
      expect(assertWebDeliveryLocation({ ...principal, ...delivery, location: { latitude: 0, longitude: 0 } })).not.toBeNull();
    }
  });

  it.each([
    ['5. POS (JWT de staff)', 'pos', 'pos'],
    ['6. external', 'external', 'external'],
  ] as const)('%s NO puede mandarla: se rechaza, no se ignora en silencio', (_name, apiClient, channel) => {
    const error = failure(() => assertWebDeliveryLocation({ apiClient, channel, ...delivery, location: point }));

    expect(error.code).toBe('delivery_location_not_supported');
    expect(error.getStatus()).toBe(400);
  });

  it('4. la autorización es por SERVICIO, no por canal: otro api_client que también produjera canal whatsapp NO queda autorizado', () => {
    const error = failure(() => assertWebDeliveryLocation({ apiClient: 'otro-gateway', channel: 'whatsapp', ...delivery, location: point }));

    expect(error.code).toBe('delivery_location_not_supported');
  });

  it('un api_client desconocido, ausente o con un nombre heredado de Object nunca se autoriza', () => {
    for (const apiClient of [undefined, '', 'WEB', 'Web', 'whatsapp', 'constructor', '__proto__', 'toString']) {
      for (const channel of ['web', 'whatsapp'] as const) {
        expect(failure(() => assertWebDeliveryLocation({ apiClient, channel, ...delivery, location: point })).code).toBe('delivery_location_not_supported');
      }
    }
  });

  it('un servicio autorizado con el canal de OTRO (credencial y canal incoherentes) tampoco pasa', () => {
    expect(failure(() => assertWebDeliveryLocation({ apiClient: 'web', channel: 'whatsapp', ...delivery, location: point })).code).toBe('delivery_location_not_supported');
    expect(failure(() => assertWebDeliveryLocation({ apiClient: 'whatsapp-gateway', channel: 'web', ...delivery, location: point })).code).toBe('delivery_location_not_supported');
  });

  it.each([WEB, GATEWAY])('7. con pickup o mesa no aplica (%j): se rechaza', (principal) => {
    for (const deliveryType of ['pickup', 'dine_in'] as const) {
      expect(failure(() => assertWebDeliveryLocation({ ...principal, deliveryType, location: point })).code).toBe('validation_error');
    }
  });

  it.each([
    ['latitud fuera de rango', { latitude: 90.0001, longitude: 0 }],
    ['latitud muy negativa', { latitude: -91, longitude: 0 }],
    ['longitud fuera de rango', { latitude: 0, longitude: 180.5 }],
    ['latitud NaN', { latitude: Number.NaN, longitude: 0 }],
    ['longitud infinita', { latitude: 0, longitude: Number.POSITIVE_INFINITY }],
    ['latitud como texto', { latitude: '-17.7' as unknown as number, longitude: 0 }],
    ['longitud nula', { latitude: 0, longitude: null as unknown as number }],
  ])('8. coordenadas inválidas (%s): validation_error para web y para whatsapp-gateway', (_name, location) => {
    for (const principal of [WEB, GATEWAY]) {
      expect(failure(() => assertWebDeliveryLocation({ ...principal, ...delivery, location })).code).toBe('validation_error');
    }
  });

  it('los errores nunca llevan las coordenadas', () => {
    const errors = [
      failure(() => assertWebDeliveryLocation({ apiClient: 'external', channel: 'external', ...delivery, location: point })),
      failure(() => assertWebDeliveryLocation({ ...GATEWAY, deliveryType: 'pickup', location: point })),
      failure(() => assertWebDeliveryLocation({ ...WEB, ...delivery, location: { latitude: 123.456, longitude: 0 } })),
    ];
    for (const error of errors) expect(JSON.stringify(error.getResponse())).not.toMatch(/17\.78|63\.18|123\.456/);
  });

  it('devuelve una copia normalizada: ningún campo extra se cuela', () => {
    const result = assertWebDeliveryLocation({ ...GATEWAY, ...delivery, location: { ...point, extra: 'x' } as never });

    expect(Object.keys(result!)).toEqual(['latitude', 'longitude']);
  });
});

describe('canSendDeliveryLocation', () => {
  it('solo web→web y whatsapp-gateway→whatsapp', () => {
    expect(canSendDeliveryLocation('web', 'web')).toBe(true);
    expect(canSendDeliveryLocation('whatsapp-gateway', 'whatsapp')).toBe(true);
    for (const [apiClient, channel] of [['pos', 'pos'], ['external', 'external'], ['web', 'whatsapp'], ['whatsapp-gateway', 'web'], [undefined, 'web']] as const) {
      expect(canSendDeliveryLocation(apiClient, channel)).toBe(false);
    }
  });
});

describe('assertDeliveryLocationForWrite (defensa en profundidad del único punto que escribe)', () => {
  it('acepta los canales con un servicio autorizado (web y whatsapp) en delivery', () => {
    for (const channel of ['web', 'whatsapp'] as const) {
      expect(assertDeliveryLocationForWrite({ channel, ...delivery, location: point })).toEqual(point);
    }
  });

  it('nunca pos ni external; ni pickup/mesa; ni coordenadas inválidas; sin ubicación devuelve null', () => {
    for (const channel of ['pos', 'external'] as const) {
      expect(failure(() => assertDeliveryLocationForWrite({ channel, ...delivery, location: point })).code).toBe('delivery_location_not_supported');
    }
    expect(failure(() => assertDeliveryLocationForWrite({ channel: 'whatsapp', deliveryType: 'pickup', location: point })).code).toBe('validation_error');
    expect(failure(() => assertDeliveryLocationForWrite({ channel: 'web', ...delivery, location: { latitude: 95, longitude: 0 } })).code).toBe('validation_error');
    expect(assertDeliveryLocationForWrite({ channel: 'pos', ...delivery, location: undefined })).toBeNull();
  });
});

describe('sameDeliveryLocation (reintentos idempotentes)', () => {
  it('ninguna con ninguna es igual; ninguna con una no', () => {
    expect(sameDeliveryLocation(null, null)).toBe(true);
    expect(sameDeliveryLocation(null, point)).toBe(false);
    expect(sameDeliveryLocation(point, null)).toBe(false);
  });

  it('exactamente los mismos números son iguales; cualquier diferencia no (sin tolerancia)', () => {
    expect(sameDeliveryLocation(point, { ...point })).toBe(true);
    expect(sameDeliveryLocation(point, { latitude: point.latitude + 1e-7, longitude: point.longitude })).toBe(false);
    expect(sameDeliveryLocation(point, { latitude: point.latitude, longitude: point.longitude - 1e-7 })).toBe(false);
  });
});

describe('idempotencia de POST /orders con ubicación', () => {
  const body = { customerName: 'Ana', deliveryType: 'delivery', paymentMethod: 'cash', items: [{ productId: 'p1', quantity: 1 }] };

  it('la ubicación forma parte del hash: la misma clave con otra ubicación es otro cuerpo (409 idempotency_key_reused)', () => {
    const a = hashRequestBody(idempotencyBody({ ...body, deliveryLocation: point }));
    const b = hashRequestBody(idempotencyBody({ ...body, deliveryLocation: { latitude: -17.9, longitude: -63.3 } }));

    expect(a).not.toBe(b);
    expect(a).toBe(hashRequestBody(idempotencyBody({ ...body, deliveryLocation: { longitude: point.longitude, latitude: point.latitude } })));
  });

  it('con y sin ubicación son cuerpos distintos; y sin ubicación el hash es el mismo de siempre (los reintentos de clientes anteriores no se rompen)', () => {
    expect(hashRequestBody(idempotencyBody(body))).not.toBe(hashRequestBody(idempotencyBody({ ...body, deliveryLocation: point })));
    // El DTO trae `deliveryLocation: undefined` como clave propia y `canonicalize` la escribiría: `idempotencyBody` la quita, así que
    // el hash de un cuerpo sin ubicación es exactamente el de antes de esta extensión.
    expect(hashRequestBody(idempotencyBody({ ...body, deliveryLocation: undefined }))).toBe(hashRequestBody(body));
    expect(hashRequestBody(idempotencyBody({ ...body, deliveryLocation: null }))).toBe(hashRequestBody(body));
    // (Sin la quita, la clave `undefined` SÍ cambiaría el hash: por eso existe.)
    expect(hashRequestBody({ ...body, deliveryLocation: undefined })).not.toBe(hashRequestBody(body));
  });
});
