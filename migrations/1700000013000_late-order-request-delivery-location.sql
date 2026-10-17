-- Up Migration
-- Ubicación del checkout web en las solicitudes fuera de horario (HTTP 202).
--
-- Un pedido de delivery del checkout web puede traer su ubicación al crearse (POST /orders con `deliveryLocation`).
-- Si cae en la ventana `late_review`, todavía NO existe un pedido: solo la solicitud (`late_order_requests`), que se
-- materializa al aceptarla. Estas dos columnas conservan la ubicación para que, al aceptarse, el pedido nazca ya ubicado y
-- cotizado en la misma transacción y nadie le pida el pin por WhatsApp.
--
-- ADITIVA y retrocompatible: dos columnas nulables, sin default y sin backfill. Las solicitudes existentes y todas las que
-- no traigan ubicación siguen igual (ambas columnas en null). Reutiliza el mismo rango que `orders.delivery_latitude/longitude`.
-- El código solo escribe estas columnas cuando la solicitud trae ubicación, así que un entorno sin migrar sigue funcionando
-- para todo lo anterior.

alter table late_order_requests
  add column if not exists delivery_latitude  double precision
    check (delivery_latitude is null or delivery_latitude between -90 and 90),
  add column if not exists delivery_longitude double precision
    check (delivery_longitude is null or delivery_longitude between -180 and 180);

-- O las dos coordenadas o ninguna.
alter table late_order_requests
  add constraint late_order_requests_delivery_location_pair
    check ((delivery_latitude is null) = (delivery_longitude is null));

-- Solo el checkout web manda ubicación al crear, y solo en delivery: ni WhatsApp, ni POS, ni pickup la guardan aquí.
alter table late_order_requests
  add constraint late_order_requests_delivery_location_web_delivery
    check (delivery_latitude is null or (channel = 'web' and delivery_type = 'delivery'));

-- Down Migration
alter table late_order_requests
  drop constraint late_order_requests_delivery_location_web_delivery,
  drop constraint late_order_requests_delivery_location_pair,
  drop column delivery_longitude,
  drop column delivery_latitude;
