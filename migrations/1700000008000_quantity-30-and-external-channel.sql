-- Up Migration
-- 1) Máximo de unidades por línea del carrito: de 10 a 30.
-- 2) Canal de origen `external`: pedidos que llegan de un POS ajeno al sistema.
--
-- (1) El DTO ya acepta hasta 30, pero el esquema rechazaba más de 10 con un
-- CHECK. Los nombres son los que Postgres asigna a un CHECK de columna
-- (<tabla>_<columna>_check); el DROP no usa IF EXISTS a propósito: si el
-- nombre fuera otro, la migración falla en vez de dejar el límite viejo.
-- `promotion_items.quantity` (cantidad de un componente dentro de un combo)
-- no es el máximo del carrito y no se toca.
alter table order_items drop constraint order_items_quantity_check;
alter table order_items
  add constraint order_items_quantity_check check (quantity between 1 and 30);

alter table order_promotions drop constraint order_promotions_combo_quantity_check;
alter table order_promotions
  add constraint order_promotions_combo_quantity_check check (combo_quantity between 1 and 30);

-- (2) `external`: lo que vende un POS externo y se reporta acá (cocina y
-- métricas). Nace pagado y se puede apagar; arranca apagado porque necesita
-- una integración deliberada (un token de servicio llamado `external`).
alter table orders drop constraint orders_channel_check;
alter table orders
  add constraint orders_channel_check
  check (channel in ('whatsapp','web','pos','external'));

alter table late_order_requests drop constraint late_order_requests_channel_check;
alter table late_order_requests
  add constraint late_order_requests_channel_check
  check (channel in ('whatsapp','web','pos','external'));

alter table operational_settings
  add column channel_external_enabled boolean not null default false;

alter table payment_options drop constraint payment_options_channels_valid;
alter table payment_options
  add constraint payment_options_channels_valid
  check (
    cardinality(channels) > 0
    and channels <@ array['pos','whatsapp','web','external']::text[]
  );

-- Down Migration
alter table payment_options drop constraint payment_options_channels_valid;
update payment_options
  set channels = array_remove(channels, 'external')
  where 'external' = any(channels);
alter table payment_options
  add constraint payment_options_channels_valid
  check (cardinality(channels) > 0 and channels <@ array['pos','whatsapp','web']::text[]);

alter table operational_settings drop column if exists channel_external_enabled;

-- Los pedidos `external` ya creados impedirían volver al CHECK anterior.
alter table late_order_requests drop constraint late_order_requests_channel_check;
alter table late_order_requests
  add constraint late_order_requests_channel_check
  check (channel in ('whatsapp','web','pos'));

alter table orders drop constraint orders_channel_check;
alter table orders
  add constraint orders_channel_check check (channel in ('whatsapp','web','pos'));

-- Volver a 10 falla si ya hay líneas con más de 10 unidades.
alter table order_promotions drop constraint order_promotions_combo_quantity_check;
alter table order_promotions
  add constraint order_promotions_combo_quantity_check check (combo_quantity between 1 and 10);

alter table order_items drop constraint order_items_quantity_check;
alter table order_items
  add constraint order_items_quantity_check check (quantity between 1 and 10);
