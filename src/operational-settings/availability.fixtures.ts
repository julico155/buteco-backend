import { AvailabilityRow } from './availability.rules';

/** Todo habilitado: para los mocks de `operational_settings` en specs que no prueban disponibilidad. */
export const ALL_AVAILABLE: AvailabilityRow = {
  service_delivery_enabled: true,
  service_pickup_enabled: true,
  service_dine_in_enabled: true,
  channel_pos_enabled: true,
  channel_whatsapp_enabled: true,
  channel_web_enabled: true,
  channel_external_enabled: false,
};
