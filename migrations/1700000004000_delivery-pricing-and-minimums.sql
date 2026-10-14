-- Up Migration
-- Pedido mínimo por tipo de servicio y esquema de tarifa de envío.
--
-- Pedido mínimo: se compara contra el subtotal (la comida, sin envío). 0 = sin
-- mínimo.
--
-- Tarifa de envío:
--   bands  -> por distancia, con la tabla delivery_tariff_bands (el esquema
--             que ya existía).
--   fixed  -> un monto único (delivery_fixed_fee), cualquier distancia.
--   free   -> sin costo de envío.
-- Aparte, delivery_free_over_amount hace gratis el envío de cualquier pedido
-- cuyo subtotal lo alcance, y delivery_max_distance_meters pone un techo de
-- reparto (más allá, el envío se cotiza a mano, igual que fuera de la última
-- banda). Un envío gratis también exime el recargo por lluvia.
alter table operational_settings
  add column min_order_delivery numeric(10,2) not null default 0 check (min_order_delivery >= 0),
  add column min_order_pickup   numeric(10,2) not null default 0 check (min_order_pickup >= 0),
  add column min_order_dine_in  numeric(10,2) not null default 0 check (min_order_dine_in >= 0),
  add column delivery_pricing_mode text not null default 'bands'
    check (delivery_pricing_mode in ('bands','fixed','free')),
  add column delivery_fixed_fee numeric(10,2) check (delivery_fixed_fee is null or delivery_fixed_fee >= 0),
  add column delivery_free_over_amount numeric(10,2)
    check (delivery_free_over_amount is null or delivery_free_over_amount > 0),
  add column delivery_max_distance_meters integer
    check (delivery_max_distance_meters is null or delivery_max_distance_meters > 0),
  add constraint operational_settings_fixed_fee_required
    check (delivery_pricing_mode <> 'fixed' or delivery_fixed_fee is not null);

-- Down Migration
alter table operational_settings
  drop constraint if exists operational_settings_fixed_fee_required,
  drop column if exists min_order_delivery,
  drop column if exists min_order_pickup,
  drop column if exists min_order_dine_in,
  drop column if exists delivery_pricing_mode,
  drop column if exists delivery_fixed_fee,
  drop column if exists delivery_free_over_amount,
  drop column if exists delivery_max_distance_meters;
