import { DomainException } from '../common/exceptions/domain-exception';
import { hashRequestBody } from '../common/idempotency/idempotency.service';
import { assertWebDeliveryLocation, idempotencyBody, sameDeliveryLocation } from './delivery-location';

/** NO se ha ejecutado todavía. Reglas puras: quién puede mandar una ubicación al crear un pedido. */
const point = { latitude: -17.7833, longitude: -63.1821 };

function failure(run: () => unknown): DomainException {
  try {
    run();
  } catch (error) {
    return error as DomainException;
  }
  throw new Error('debía lanzar');
}

describe('assertWebDeliveryLocation', () => {
  it('sin ubicación devuelve null para cualquier canal y servicio: los clientes anteriores no cambian', () => {
    for (const channel of ['whatsapp', 'web', 'pos', 'external'] as const) {
      for (const deliveryType of ['delivery', 'pickup', 'dine_in'] as const) {
        expect(assertWebDeliveryLocation({ channel, deliveryType, location: undefined })).toBeNull();
        expect(assertWebDeliveryLocation({ channel, deliveryType, location: null })).toBeNull();
      }
    }
  });

  it('canal web + delivery + coordenadas válidas: devuelve la ubicación', () => {
    expect(assertWebDeliveryLocation({ channel: 'web', deliveryType: 'delivery', location: point })).toEqual(point);
  });

  it('acepta los extremos del rango geográfico', () => {
    expect(assertWebDeliveryLocation({ channel: 'web', deliveryType: 'delivery', location: { latitude: 90, longitude: 180 } })).not.toBeNull();
    expect(assertWebDeliveryLocation({ channel: 'web', deliveryType: 'delivery', location: { latitude: -90, longitude: -180 } })).not.toBeNull();
    expect(assertWebDeliveryLocation({ channel: 'web', deliveryType: 'delivery', location: { latitude: 0, longitude: 0 } })).not.toBeNull();
  });

  it.each(['whatsapp', 'pos', 'external'] as const)('el canal %s NO puede mandarla: se rechaza, no se ignora en silencio', (channel) => {
    const error = failure(() => assertWebDeliveryLocation({ channel, deliveryType: 'delivery', location: point }));

    expect(error.code).toBe('delivery_location_not_supported');
    expect(error.getStatus()).toBe(400);
  });

  it.each(['pickup', 'dine_in'] as const)('con %s no aplica: se rechaza', (deliveryType) => {
    expect(failure(() => assertWebDeliveryLocation({ channel: 'web', deliveryType, location: point })).code).toBe('validation_error');
  });

  it.each([
    ['latitud fuera de rango', { latitude: 90.0001, longitude: 0 }],
    ['latitud muy negativa', { latitude: -91, longitude: 0 }],
    ['longitud fuera de rango', { latitude: 0, longitude: 180.5 }],
    ['latitud NaN', { latitude: Number.NaN, longitude: 0 }],
    ['longitud infinita', { latitude: 0, longitude: Number.POSITIVE_INFINITY }],
    ['latitud como texto', { latitude: '-17.7' as unknown as number, longitude: 0 }],
    ['longitud nula', { latitude: 0, longitude: null as unknown as number }],
  ])('coordenadas inválidas (%s): validation_error', (_name, location) => {
    expect(failure(() => assertWebDeliveryLocation({ channel: 'web', deliveryType: 'delivery', location })).code).toBe('validation_error');
  });

  it('los errores nunca llevan las coordenadas', () => {
    const errors = [
      failure(() => assertWebDeliveryLocation({ channel: 'whatsapp', deliveryType: 'delivery', location: point })),
      failure(() => assertWebDeliveryLocation({ channel: 'web', deliveryType: 'pickup', location: point })),
      failure(() => assertWebDeliveryLocation({ channel: 'web', deliveryType: 'delivery', location: { latitude: 123.456, longitude: 0 } })),
    ];
    for (const error of errors) expect(JSON.stringify(error.getResponse())).not.toMatch(/17\.78|63\.18|123\.456/);
  });

  it('devuelve una copia normalizada: ningún campo extra se cuela', () => {
    const result = assertWebDeliveryLocation({ channel: 'web', deliveryType: 'delivery', location: { ...point, extra: 'x' } as never });

    expect(Object.keys(result!)).toEqual(['latitude', 'longitude']);
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
