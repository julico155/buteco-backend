import { HttpStatus } from '@nestjs/common';
import { DomainException, ValidationError } from '../common/exceptions/domain-exception';
import { OrderChannel, OrderDeliveryType } from '../database/types';

export type ServiceAvailability = Record<OrderDeliveryType, boolean>;
export type ChannelAvailability = Record<OrderChannel, boolean>;

/** Subconjunto de `operational_settings` que estas reglas leen. */
export interface AvailabilityRow {
  service_delivery_enabled: boolean;
  service_pickup_enabled: boolean;
  service_dine_in_enabled: boolean;
  channel_pos_enabled: boolean;
  channel_whatsapp_enabled: boolean;
  channel_web_enabled: boolean;
  channel_external_enabled: boolean;
}

export function serviceAvailability(row: AvailabilityRow): ServiceAvailability {
  return {
    delivery: row.service_delivery_enabled,
    pickup: row.service_pickup_enabled,
    dine_in: row.service_dine_in_enabled,
  };
}

export function channelAvailability(row: AvailabilityRow): ChannelAvailability {
  return {
    pos: row.channel_pos_enabled,
    whatsapp: row.channel_whatsapp_enabled,
    web: row.channel_web_enabled,
    external: row.channel_external_enabled,
  };
}

function enabledKeys<K extends string>(map: Record<K, boolean>): K[] {
  return (Object.keys(map) as K[]).filter((key) => map[key]);
}

/** Un pedido nuevo de un tipo de servicio apagado se rechaza con las alternativas. */
export function assertServiceTypeEnabled(
  availability: ServiceAvailability,
  serviceType: OrderDeliveryType,
): void {
  if (availability[serviceType]) return;
  throw new DomainException(
    'service_type_disabled',
    HttpStatus.BAD_REQUEST,
    'Este local no está tomando pedidos de ese tipo de servicio.',
    { serviceType, available: enabledKeys(availability) },
  );
}

/** El canal sale de la credencial, no del body: apagarlo corta ese origen entero. */
export function assertChannelEnabled(availability: ChannelAvailability, channel: OrderChannel): void {
  if (availability[channel]) return;
  throw new DomainException(
    'channel_disabled',
    HttpStatus.CONFLICT,
    'Este canal no está tomando pedidos en este momento.',
    { channel, available: enabledKeys(availability) },
  );
}

/**
 * Valida el estado resultante de un cambio de configuración:
 *  - al menos un tipo de servicio y un canal prendidos (si no, el local no
 *    puede vender nada);
 *  - todo tipo de servicio prendido tiene al menos una forma de pago
 *    habilitada (si no, los pedidos fallarían uno por uno).
 */
export function assertAvailabilityConsistent(
  services: ServiceAvailability,
  channels: ChannelAvailability,
  paymentOptions: { service_type: OrderDeliveryType; enabled: boolean }[],
): void {
  if (enabledKeys(services).length === 0) {
    throw new ValidationError('Tiene que haber al menos un tipo de servicio habilitado.');
  }
  if (enabledKeys(channels).length === 0) {
    throw new ValidationError('Tiene que haber al menos un canal habilitado.');
  }
  const withoutPayment = enabledKeys(services).filter(
    (type) => !paymentOptions.some((o) => o.service_type === type && o.enabled),
  );
  if (withoutPayment.length > 0) {
    throw new DomainException(
      'no_payment_option_enabled',
      HttpStatus.CONFLICT,
      'No se puede habilitar un tipo de servicio sin ninguna forma de pago habilitada (ver /payment-options).',
      { serviceTypes: withoutPayment },
    );
  }
}
