-- Up Migration
-- Mesas con plano (varios ambientes) y cuenta abierta por mesa.
--
-- Una cuenta de mesa es UN pedido dine_in en estado `open`: se le agregan
-- rondas (order_items / order_promotions con round_number) y recién al final
-- se cobra. Un solo pedido porque el banco asocia un QR a un pedido y el
-- cliente quiere un QR por el total.

create table floors (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 60),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index floors_name_key on floors (lower(name));

create table tables (
  id          uuid primary key default gen_random_uuid(),
  floor_id    uuid not null references floors (id),
  label       text not null check (char_length(label) between 1 and 40),
  seats       integer not null default 4 check (seats between 1 and 100),
  -- Posición y tamaño en el plano (vista desde arriba), en unidades del editor.
  x           numeric(8,2) not null default 0,
  y           numeric(8,2) not null default 0,
  width       numeric(8,2) not null default 80 check (width > 0),
  height      numeric(8,2) not null default 80 check (height > 0),
  rotation    numeric(6,2) not null default 0,
  shape       text not null default 'square' check (shape in ('square','round','rectangle')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index tables_floor_label_key on tables (floor_id, lower(label));

-- `open`: cuenta de mesa todavía sin cobrar.
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check check (status in (
  'draft','awaiting_location','open','confirmed','preparing','ready',
  'out_for_delivery','delivered','cancelled'
));

alter table orders
  add column table_id           uuid references tables (id),
  add column bill_requested_at  timestamptz;

-- Una mesa tiene a lo sumo una cuenta viva: abierta, o cerrada pero todavía
-- sin pagar (QR pendiente). Cobrada o cancelada libera la mesa.
create unique index orders_one_live_account_per_table
  on orders (table_id)
  where table_id is not null
    and status in ('open', 'confirmed')
    and payment_status <> 'paid';

create index orders_table_id_idx on orders (table_id) where table_id is not null;

-- Rondas y anulación. Anular no borra: la línea queda con quién y por qué, y
-- el total, la comanda y los reportes la ignoran (voided_at is null).
alter table order_items
  add column round_number  integer not null default 1 check (round_number >= 1),
  add column added_at      timestamptz not null default now(),
  add column voided_at     timestamptz,
  add column voided_by     text,
  add column void_reason   text;

alter table order_promotions
  add column round_number  integer not null default 1 check (round_number >= 1),
  add column added_at      timestamptz not null default now(),
  add column voided_at     timestamptz,
  add column voided_by     text,
  add column void_reason   text;

-- Down Migration
alter table order_promotions
  drop column void_reason, drop column voided_by, drop column voided_at,
  drop column added_at, drop column round_number;
alter table order_items
  drop column void_reason, drop column voided_by, drop column voided_at,
  drop column added_at, drop column round_number;
drop index if exists orders_table_id_idx;
drop index if exists orders_one_live_account_per_table;
alter table orders drop column bill_requested_at, drop column table_id;
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check check (status in (
  'draft','awaiting_location','confirmed','preparing','ready',
  'out_for_delivery','delivered','cancelled'
));
drop table tables;
drop table floors;
