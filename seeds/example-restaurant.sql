-- Seed de EJEMPLO para un restaurante nuevo. Copiarlo, ajustar los valores y
-- correrlo UNA vez contra la base del restaurante después de `migrate:up`:
--
--   psql "$DATABASE_URL" -f seeds/mi-restaurante.sql
--
-- El baseline deja `operational_settings` con su fila única en valores por
-- defecto y `delivery_tariff_bands` vacía: sin bandas, ninguna cotización de
-- delivery tiene tarifa que aplicar. Todo lo de abajo son valores de
-- muestra, no los de ningún restaurante real.

-- Ubicación del local: origen para medir la distancia de delivery.
update operational_settings
set restaurant_latitude  = 0.000000,   -- TODO: latitud real
    restaurant_longitude = 0.000000,   -- TODO: longitud real
    updated_at = now()
where id = true;

-- Bandas de tarifa. Banda k cubre (max de la banda anterior, max de ésta]
-- metros. Más allá de la última banda el pedido queda en `pending_manual`.
insert into delivery_tariff_bands (band_index, max_distance_meters, fee_amount) values
  (1, 1000, 5),
  (2, 2000, 7),
  (3, 3000, 9),
  (4, 5000, 12),
  (5, 8000, 16);
