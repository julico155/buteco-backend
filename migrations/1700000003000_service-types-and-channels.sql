-- Up Migration
-- Qué tipos de servicio y qué canales vende este local. Todo arranca
-- habilitado (comportamiento anterior); un restaurante sin reparto apaga
-- `service_delivery_enabled` y deja de aceptar pedidos de delivery.
--
-- Solo afecta a pedidos NUEVOS: lo que ya existe sigue su ciclo normal
-- (cocina, cobro, entrega) aunque después se apague su servicio o canal.
alter table operational_settings
  add column service_delivery_enabled  boolean not null default true,
  add column service_pickup_enabled    boolean not null default true,
  add column service_dine_in_enabled   boolean not null default true,
  add column channel_pos_enabled       boolean not null default true,
  add column channel_whatsapp_enabled  boolean not null default true,
  add column channel_web_enabled       boolean not null default true,
  add constraint operational_settings_one_service
    check (service_delivery_enabled or service_pickup_enabled or service_dine_in_enabled),
  add constraint operational_settings_one_channel
    check (channel_pos_enabled or channel_whatsapp_enabled or channel_web_enabled);

-- Down Migration
alter table operational_settings
  drop constraint if exists operational_settings_one_service,
  drop constraint if exists operational_settings_one_channel,
  drop column if exists service_delivery_enabled,
  drop column if exists service_pickup_enabled,
  drop column if exists service_dine_in_enabled,
  drop column if exists channel_pos_enabled,
  drop column if exists channel_whatsapp_enabled,
  drop column if exists channel_web_enabled;
