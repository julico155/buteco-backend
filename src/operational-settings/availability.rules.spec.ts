import { DomainException, ValidationError } from '../common/exceptions/domain-exception';
import {
  assertAvailabilityConsistent,
  assertChannelEnabled,
  assertServiceTypeEnabled,
  channelAvailability,
  serviceAvailability,
} from './availability.rules';
import { ALL_AVAILABLE } from './availability.fixtures';

const ALL_SERVICES = { delivery: true, pickup: true, dine_in: true };
const ALL_CHANNELS = { pos: true, whatsapp: true, web: true, external: false };
const PAYMENT_OK = [
  { service_type: 'delivery' as const, enabled: true },
  { service_type: 'pickup' as const, enabled: true },
  { service_type: 'dine_in' as const, enabled: true },
];

function catchError(fn: () => unknown): DomainException {
  try {
    fn();
  } catch (error) {
    return error as DomainException;
  }
  throw new Error('debía lanzar');
}

describe('serviceAvailability / channelAvailability', () => {
  it('mapean las columnas de operational_settings', () => {
    const row = { ...ALL_AVAILABLE, service_delivery_enabled: false, channel_web_enabled: false };
    expect(serviceAvailability(row)).toEqual({ delivery: false, pickup: true, dine_in: true });
    expect(channelAvailability(row)).toEqual({ pos: true, whatsapp: true, web: false, external: false });
  });
});

describe('assertServiceTypeEnabled', () => {
  it('acepta uno habilitado', () => {
    expect(() => assertServiceTypeEnabled(ALL_SERVICES, 'delivery')).not.toThrow();
  });

  it('rechaza uno apagado con 400 service_type_disabled y las alternativas', () => {
    const error = catchError(() =>
      assertServiceTypeEnabled({ ...ALL_SERVICES, delivery: false }, 'delivery'),
    );
    expect(error.code).toBe('service_type_disabled');
    expect(error.getStatus()).toBe(400);
    expect(error.details).toEqual({ serviceType: 'delivery', available: ['pickup', 'dine_in'] });
  });
});

describe('assertChannelEnabled', () => {
  it('acepta uno habilitado', () => {
    expect(() => assertChannelEnabled(ALL_CHANNELS, 'web')).not.toThrow();
  });

  it('rechaza uno apagado con 409 channel_disabled', () => {
    const error = catchError(() => assertChannelEnabled({ ...ALL_CHANNELS, web: false }, 'web'));
    expect(error.code).toBe('channel_disabled');
    expect(error.getStatus()).toBe(409);
    expect(error.details).toEqual({ channel: 'web', available: ['pos', 'whatsapp'] });
  });
});

describe('assertAvailabilityConsistent', () => {
  it('pasa con todo habilitado', () => {
    expect(() => assertAvailabilityConsistent(ALL_SERVICES, ALL_CHANNELS, PAYMENT_OK)).not.toThrow();
  });

  it('no deja apagar todos los servicios', () => {
    expect(() =>
      assertAvailabilityConsistent(
        { delivery: false, pickup: false, dine_in: false },
        ALL_CHANNELS,
        PAYMENT_OK,
      ),
    ).toThrow(ValidationError);
  });

  it('no deja apagar todos los canales', () => {
    expect(() =>
      assertAvailabilityConsistent(
        ALL_SERVICES,
        { pos: false, whatsapp: false, web: false, external: false },
        PAYMENT_OK,
      ),
    ).toThrow(ValidationError);
  });

  it('un servicio apagado no necesita forma de pago', () => {
    const paymentWithoutDelivery = PAYMENT_OK.map((o) =>
      o.service_type === 'delivery' ? { ...o, enabled: false } : o,
    );
    expect(() =>
      assertAvailabilityConsistent(
        { ...ALL_SERVICES, delivery: false },
        ALL_CHANNELS,
        paymentWithoutDelivery,
      ),
    ).not.toThrow();
  });

  it('no deja prender un servicio sin ninguna forma de pago habilitada', () => {
    const paymentWithoutDelivery = PAYMENT_OK.map((o) =>
      o.service_type === 'delivery' ? { ...o, enabled: false } : o,
    );
    const error = catchError(() =>
      assertAvailabilityConsistent(ALL_SERVICES, ALL_CHANNELS, paymentWithoutDelivery),
    );
    expect(error.code).toBe('no_payment_option_enabled');
    expect(error.details).toEqual({ serviceTypes: ['delivery'] });
  });

  it('el canal external arranca apagado y se prende por separado', () => {
    expect(channelAvailability(ALL_AVAILABLE).external).toBe(false);
    expect(channelAvailability({ ...ALL_AVAILABLE, channel_external_enabled: true }).external).toBe(true);
    const error = catchError(() => assertChannelEnabled(channelAvailability(ALL_AVAILABLE), 'external'));
    expect(error.code).toBe('channel_disabled');
  });
});
