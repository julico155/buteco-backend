-- Up Migration
-- Horario semanal: días que abre el local y hora límite de pedidos por tipo de
-- servicio (delivery y recojo tienen límites distintos).
--
-- open_weekdays: domingo = 0 ... sábado = 6.
-- *_last_order_minute: minuto del día (0-1439) hasta el que se acepta un pedido
-- de ese servicio; null = sin tope propio (rige solo el margen horario).
alter table operational_settings
  add column open_weekdays              smallint[] not null default '{0,1,2,3,4,5,6}',
  add column delivery_last_order_minute integer
    check (delivery_last_order_minute is null or delivery_last_order_minute between 0 and 1439),
  add column pickup_last_order_minute   integer
    check (pickup_last_order_minute is null or pickup_last_order_minute between 0 and 1439),
  add constraint open_weekdays_valid
    check (open_weekdays <@ array[0,1,2,3,4,5,6]::smallint[]);

-- Buteco: martes a domingo, abre 12:00 y cierra 23:00; delivery hasta 22:50 y
-- recojo hasta 22:30. Los valores por defecto de la plantilla (17 a 22) no
-- aplican a este local.
update operational_settings
   set open_weekdays = '{2,3,4,5,6,0}',
       business_opens_hour = 12,
       business_closes_hour = 23,
       delivery_last_order_minute = 22 * 60 + 50,
       pickup_last_order_minute = 22 * 60 + 30
 where id = true;

-- Down Migration
alter table operational_settings
  drop constraint open_weekdays_valid,
  drop column pickup_last_order_minute,
  drop column delivery_last_order_minute,
  drop column open_weekdays;
