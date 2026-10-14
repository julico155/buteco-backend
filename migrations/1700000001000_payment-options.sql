-- Up Migration
-- Métodos de pago activables por tipo de servicio.
--
-- Una fila por combinación que el sistema sabe cobrar; el admin solo prende
-- o apaga `enabled` (nunca crea filas nuevas). `qr_scope` distingue, solo en
-- delivery con QR, qué cubre el QR:
--   food_only          -> el QR cobra la comida; el envío lo cobra el
--                         repartidor en efectivo al entregar.
--   food_and_delivery  -> el QR cobra comida + envío; el repartidor no cobra.
-- Para todo lo demás vale 'none'.
create table payment_options (
  service_type    text not null check (service_type in ('delivery','pickup','dine_in')),
  payment_method  text not null check (payment_method in ('qr','cash','split')),
  qr_scope        text not null default 'none'
                    check (qr_scope in ('none','food_only','food_and_delivery')),
  enabled         boolean not null default true,
  updated_at      timestamptz not null default now(),
  updated_by      text,
  primary key (service_type, payment_method, qr_scope),
  -- qr_scope solo tiene sentido para QR en delivery, y es obligatorio ahí.
  check ((payment_method = 'qr' and service_type = 'delivery') = (qr_scope <> 'none'))
);

-- Defaults = comportamiento previo a esta tabla: presencial acepta efectivo,
-- QR y split; delivery acepta QR solo comida y efectivo contra entrega.
-- QR comida + envío es nuevo y arranca apagado.
insert into payment_options (service_type, payment_method, qr_scope, enabled) values
  ('pickup',   'cash',  'none',              true),
  ('pickup',   'qr',    'none',              true),
  ('pickup',   'split', 'none',              true),
  ('dine_in',  'cash',  'none',              true),
  ('dine_in',  'qr',    'none',              true),
  ('dine_in',  'split', 'none',              true),
  ('delivery', 'cash',  'none',              true),
  ('delivery', 'qr',    'food_only',         true),
  ('delivery', 'qr',    'food_and_delivery', false);

-- Mismo criterio que 1700000018000 (baseline): RLS activo y acceso total
-- solo para el rol con el que corre el backend.
alter table payment_options enable row level security;
create policy backend_full_access on payment_options
  for all to current_user using (true) with check (true);

-- Qué cubrió el QR de este pedido, congelado al crearlo. null para todo lo
-- que no sea delivery pagado por QR (ahí el QR cubre el total, que es igual
-- al subtotal).
alter table orders
  add column qr_scope text null
    check (qr_scope is null or qr_scope in ('food_only','food_and_delivery'));

-- La solicitud fuera de horario guarda el carrito crudo y lo revalida al
-- aceptarse: tiene que recordar qué eligió el cliente.
alter table late_order_requests
  add column qr_scope text null
    check (qr_scope is null or qr_scope in ('food_only','food_and_delivery'));

-- Down Migration
alter table late_order_requests drop column if exists qr_scope;
alter table orders drop column if exists qr_scope;
drop table if exists payment_options;
