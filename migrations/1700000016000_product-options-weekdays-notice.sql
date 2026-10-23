-- Up Migration
-- Carta del menú web: opciones de producto, disponibilidad por día y datos para el aviso de delivery.
--
-- ADITIVA: ninguna columna ni tabla existente cambia de significado. Un producto sin grupos, sin días y sin etiquetas se
-- comporta exactamente como antes.
--
--   - `product_option_groups` / `product_options`: grupos de opciones que el cliente ELIGE al pedir (p. ej. «Carne 1»,
--     «Tamaño»). Cada opción puede sumar un `price_delta` al precio base del producto. El `code` es el contrato con el menú
--     (identifica qué recorte dibujar) y es único dentro de su producto / grupo.
--   - `order_items.selected_options`: snapshot de lo elegido en la línea (ids + nombres + delta), igual que
--     `components_snapshot`: un cambio posterior del catálogo no altera pedidos viejos. Sin FK a propósito.
--   - `products.available_weekdays`: días de la semana (domingo = 0 … sábado = 6, día calendario de America/La_Paz) en que se
--     vende; null = todos los días.
--   - `products.serves_label` («2 a 3 personas») y `products.prep_minutes` (minutos de preparación).

create table product_option_groups (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references products(id) on delete cascade,
  code         text not null check (btrim(code) <> ''),
  name         text not null check (btrim(name) <> ''),
  min_select   smallint not null default 1 check (min_select >= 0),
  max_select   smallint not null default 1 check (max_select >= 1),
  sort_order   integer not null default 0,
  -- true: lo elegido en este grupo se nombra en el aviso de delivery (p. ej. «Tamaño» → «1 persona»).
  show_in_notice boolean not null default false,
  created_at   timestamptz not null default now(),
  constraint uq_product_option_groups_product_code unique (product_id, code),
  constraint ck_product_option_groups_min_max check (min_select <= max_select)
);

create index idx_product_option_groups_product_id on product_option_groups (product_id);

create table product_options (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references product_option_groups(id) on delete cascade,
  code         text not null check (btrim(code) <> ''),
  name         text not null check (btrim(name) <> ''),
  price_delta  numeric(10,2) not null default 0 check (price_delta >= 0),
  is_available boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  constraint uq_product_options_group_code unique (group_id, code)
);

create index idx_product_options_group_id on product_options (group_id);

alter table products
  add column available_weekdays smallint[] null,
  add column serves_label       text null,
  add column prep_minutes       integer null;

alter table products
  add constraint ck_products_available_weekdays
    check (
      available_weekdays is null
      or (cardinality(available_weekdays) between 1 and 7 and available_weekdays <@ array[0,1,2,3,4,5,6]::smallint[])
    ),
  add constraint ck_products_serves_label check (serves_label is null or btrim(serves_label) <> ''),
  add constraint ck_products_prep_minutes check (prep_minutes is null or prep_minutes between 1 and 600);

alter table order_items
  add column selected_options jsonb not null default '[]'::jsonb;

-- Down Migration
alter table order_items
  drop column selected_options;

alter table products
  drop constraint ck_products_prep_minutes,
  drop constraint ck_products_serves_label,
  drop constraint ck_products_available_weekdays,
  drop column prep_minutes,
  drop column serves_label,
  drop column available_weekdays;

drop table product_options;
drop table product_option_groups;
