-- Up Migration
-- Caja opcional y política de pedidos fuera de horario.
--
-- require_open_register = false: cobrar no exige caja abierta (el pago queda
-- sin sesión y entra a los reportes por fecha), y el gate de horario deja de
-- mirar la caja. La numeración de pedidos pasa a un contador por día de
-- negocio (order_day_counters) en vez de por apertura de caja.
--
-- out_of_hours_policy: qué hacer con un pedido que llega dentro del margen
-- horario pero con la caja cerrada (hoy: encolarlo para aprobación humana).
--   queue  -> late_order_requests, como siempre.
--   reject -> se rechaza como "cerrado".
--   accept -> se toma directo (el cobro sigue exigiendo caja si es obligatoria).
alter table operational_settings
  add column require_open_register boolean not null default true,
  add column out_of_hours_policy text not null default 'queue'
    check (out_of_hours_policy in ('queue','reject','accept'));

create table order_day_counters (
  day         date primary key,
  last_number integer not null default 0,
  updated_at  timestamptz not null default now()
);

alter table order_day_counters enable row level security;
create policy backend_full_access on order_day_counters
  for all to current_user using (true) with check (true);

-- Down Migration
drop table if exists order_day_counters;
alter table operational_settings
  drop column if exists require_open_register,
  drop column if exists out_of_hours_policy;
