-- Up Migration
-- Reservas de mesa con adelanto por QR.
--
-- Una reserva bloquea una mesa concreta (la más chica que alcance; el cliente
-- nunca la ve) durante `block_minutes`. Queda `pending_payment` hasta que el
-- adelanto entra por el QR del banco (`payment_ttl_minutes`); si no llega a
-- tiempo se libera. Confirmada, sigue activa `hold_minutes` desde su hora: si
-- el cliente no se presenta pierde el adelanto.
--
-- El adelanto es un pedido propio (`orders.reservation_deposit`): así reusa
-- tal cual el QR, el sondeo del banco y los reportes. Al sentarse, la cuenta de
-- la mesa lo descuenta (`orders.deposit_credit_amount`) y su total queda neto.

create sequence reservation_number_seq;

create table reservation_settings (
  id                              boolean primary key default true check (id),
  enabled                         boolean not null default true,
  deposit_amount                  numeric(10,2) not null default 100 check (deposit_amount >= 0),
  slot_minutes                    integer not null default 30 check (slot_minutes between 5 and 240),
  block_minutes                   integer not null default 120 check (block_minutes between 30 and 480),
  hold_minutes                    integer not null default 30 check (hold_minutes between 0 and 240),
  payment_ttl_minutes             integer not null default 5 check (payment_ttl_minutes between 1 and 60),
  cancel_refund_hours             integer not null default 4 check (cancel_refund_hours between 0 and 168),
  min_lead_minutes                integer not null default 30 check (min_lead_minutes between 0 and 1440),
  max_days_ahead                  integer not null default 14 check (max_days_ahead between 1 and 90),
  max_occupancy_percent           integer not null default 90 check (max_occupancy_percent between 1 and 100),
  last_slot_before_close_minutes  integer not null default 60 check (last_slot_before_close_minutes between 0 and 600),
  updated_at                      timestamptz not null default now()
);
insert into reservation_settings default values;

create table reservations (
  id                  uuid primary key default gen_random_uuid(),
  reservation_number  text not null,
  table_id            uuid not null references tables (id),
  party_size          integer not null check (party_size between 1 and 100),
  customer_name       text not null check (char_length(customer_name) between 1 and 100),
  customer_phone      text not null check (char_length(customer_phone) between 5 and 30),
  notes               text check (notes is null or char_length(notes) <= 500),
  starts_at           timestamptz not null,
  -- starts_at + block_minutes, congelado al reservar: cambiar el ajuste después
  -- no mueve reservas ya hechas.
  blocks_until        timestamptz not null,
  -- Fin del plazo para pagar el adelanto (pending_payment) o para llegar
  -- (confirmed): starts_at + hold_minutes.
  expires_at          timestamptz not null,
  status              text not null default 'pending_payment' check (status in (
    'pending_payment','confirmed','seated','cancelled','no_show','expired'
  )),
  deposit_amount      numeric(10,2) not null check (deposit_amount >= 0),
  deposit_status      text not null default 'pending' check (deposit_status in (
    'none','pending','paid','refund_due','refunded','forfeited','applied'
  )),
  deposit_order_id    uuid references orders (id),
  account_order_id    uuid references orders (id),
  cancelled_at        timestamptz,
  cancel_reason       text,
  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index reservations_table_window_idx
  on reservations (table_id, starts_at, blocks_until)
  where status in ('pending_payment', 'confirmed', 'seated');
create index reservations_status_starts_idx on reservations (status, starts_at);
create index reservations_deposit_order_idx on reservations (deposit_order_id);

alter table orders
  add column deposit_credit_amount numeric(10,2) not null default 0
    check (deposit_credit_amount >= 0),
  add column reservation_deposit boolean not null default false;

-- Down Migration
alter table orders drop column reservation_deposit, drop column deposit_credit_amount;
drop table reservations;
drop table reservation_settings;
drop sequence reservation_number_seq;
