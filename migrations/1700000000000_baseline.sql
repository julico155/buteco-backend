-- Up Migration
-- Baseline de la plantilla: esquema completo equivalente a aplicar en orden
-- las migraciones históricas 1700000001000..1700000039000 del proyecto
-- original, con estos cambios deliberados:
--   * Sin datos de ningún restaurante (coordenadas, bandas de tarifa): van
--     en un seed por restaurante, ver seeds/.
--   * Sin el método de pago 'card' (nunca se usó): los CHECK de
--     payment_method quedan en ('qr','cash','split') / ('qr','cash').
--   * Sin backfills de filas existentes (la base arranca vacía).
-- Los separadores "=====" conservan de qué migración viene cada bloque.

-- ===== 1700000001000_categories-and-products =====
-- Catálogo: categorías normalizadas (reemplazan el enum plato|bebida|extra)
-- y productos (antes menu_items).

create table categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (btrim(name) <> ''),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table products (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null check (btrim(name) <> ''),
  category_id   uuid not null references categories(id) on delete restrict,
  price         numeric(10,2) not null check (price >= 0),
  is_active     boolean not null default true,
  -- is_active = ¿existe en el catálogo? is_available = ¿hay stock hoy?
  -- Son ortogonales: NUNCA colapsar en un solo booleano (invariante 4 del plan).
  is_available  boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_products_category_id on products (category_id);

-- ===== 1700000002000_customers =====
-- Cliente como entidad normal, reemplaza el string customer_phone repetido
-- en cada tabla del diseño anterior.

create table customers (
  id          uuid primary key default gen_random_uuid(),
  name        text,
  phone       text unique,
  email       text unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint customers_has_identity check (
    phone is not null or email is not null or name is not null
  )
);

-- ===== 1700000003000_idempotency-keys =====
-- Idempotencia genérica de API (reemplaza el fingerprint atado a
-- menu_sessions del diseño anterior). Patrón estándar tipo Stripe:
-- INSERT ... ON CONFLICT sobre (api_client, endpoint, idempotency_key).
-- - Existe con mismo request_hash y completed_at no nulo -> devolver
--   response_body/response_status guardados (created:false).
-- - Existe con request_hash distinto -> 409 idempotency_key_reused.
-- - Existe con completed_at null -> hay otra ejecución en curso (bloquear
--   o reintentar), nunca proceder en paralelo con la misma key.

create table idempotency_keys (
  id               uuid primary key default gen_random_uuid(),
  api_client       text not null,
  endpoint         text not null,
  idempotency_key  text not null,
  request_hash     text not null,
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  constraint idempotency_keys_unique unique (api_client, endpoint, idempotency_key)
);

-- ===== 1700000004000_orders =====
-- Pedidos y líneas, con snapshot de nombre/precio (invariante 3: un pedido
-- histórico nunca se recalcula desde el catálogo vigente).

create sequence order_number_seq;

create table orders (
  id                          uuid primary key default gen_random_uuid(),
  order_number                text not null unique
    default ('ORD-' || lpad(nextval('order_number_seq')::text, 6, '0')),
  customer_id                 uuid references customers(id) on delete restrict,
  channel                     text not null check (channel in ('whatsapp','web','pos')),
  customer_name               text not null
    check (char_length(btrim(customer_name)) between 1 and 100),
  delivery_type               text not null check (delivery_type in ('delivery','pickup')),
  payment_method              text not null check (payment_method in ('qr','cash')),
  -- unpaid: no requiere nada (ej. cash en POS ya cobrado al vender).
  -- pending_review: hay un payment_attempt abierto esperando revisión humana.
  -- paid / rejected: desenlace del intento.
  payment_status              text not null default 'unpaid'
    check (payment_status in ('unpaid','pending_review','paid','rejected')),
  notes                       text check (notes is null or char_length(notes) <= 500),
  status                      text not null default 'draft' check (status in (
    'draft','awaiting_location','confirmed','preparing','ready',
    'out_for_delivery','delivered','cancelled'
  )),
  subtotal_amount             numeric(10,2) not null check (subtotal_amount >= 0),
  delivery_base_amount        numeric(10,2) not null default 0 check (delivery_base_amount >= 0),
  delivery_surcharge_amount   numeric(10,2) not null default 0 check (delivery_surcharge_amount >= 0),
  total_amount                numeric(10,2) not null check (total_amount >= 0),
  delivery_pricing            text check (delivery_pricing is null or delivery_pricing = 'dynamic'),
  delivery_quote_status       text check (delivery_quote_status is null or delivery_quote_status in (
    'pending','quoted','pending_manual','failed'
  )),
  delivery_distance_meters    integer check (delivery_distance_meters is null or delivery_distance_meters >= 0),
  delivery_latitude           double precision check (delivery_latitude between -90 and 90),
  delivery_longitude          double precision check (delivery_longitude between -180 and 180),
  delivery_fee_paid           boolean not null default false,
  cash_confirmed_at           timestamptz,
  confirmed_at                timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index idx_orders_customer_id on orders (customer_id);
create index idx_orders_status on orders (status);

create table order_items (
  id                     uuid primary key default gen_random_uuid(),
  order_id               uuid not null references orders(id) on delete cascade,
  product_id             uuid not null references products(id) on delete restrict,
  -- Snapshot: el pedido histórico NUNCA se recalcula desde el catálogo vigente.
  product_code_snapshot  text not null,
  product_name_snapshot  text not null,
  unit_price_snapshot    numeric(10,2) not null check (unit_price_snapshot >= 0),
  quantity               integer not null check (quantity between 1 and 10),
  subtotal               numeric(10,2) not null check (subtotal >= 0),
  created_at             timestamptz not null default now()
);

create index idx_order_items_order_id on order_items (order_id);

-- ===== 1700000005000_late-order-requests =====
-- Solicitudes que requieren aprobación humana antes de existir como pedido
-- (hoy solo por horario nocturno; el mecanismo es genérico).

create table late_order_requests (
  id                uuid primary key default gen_random_uuid(),
  request_number    text not null unique,
  customer_id       uuid references customers(id) on delete restrict,
  customer_name     text not null check (char_length(btrim(customer_name)) between 1 and 100),
  channel           text not null check (channel in ('whatsapp','web','pos')),
  delivery_type     text not null check (delivery_type in ('delivery','pickup')),
  payment_method    text not null check (payment_method in ('qr','cash')),
  notes             text check (notes is null or char_length(notes) <= 500),
  items_json        jsonb not null check (jsonb_typeof(items_json) = 'array'),
  promotions_json    jsonb not null default '[]'::jsonb,
  subtotal_amount   numeric(10,2) not null check (subtotal_amount > 0),
  idempotency_key   text not null unique,
  status            text not null default 'pending'
    check (status in ('pending','accepted','rejected','expired')),
  requested_at      timestamptz not null default now(),
  expires_at        timestamptz not null,
  decided_at        timestamptz,
  decided_by        text,
  order_id          uuid references orders(id) on delete restrict,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint late_order_requests_pending_is_clean check (
    status <> 'pending' or (decided_at is null and decided_by is null and order_id is null)
  ),
  constraint late_order_requests_order_only_when_accepted check (
    order_id is null or status = 'accepted'
  )
);

-- Barrido de solicitudes pendientes (worker de expiración), patrón parcial
-- sobre el estado "pendiente" en vez de la tabla completa.
create index idx_late_order_requests_pending
  on late_order_requests (expires_at)
  where status = 'pending';

-- ===== 1700000006000_delivery =====
-- Tabla de bandas de tarifa: fuente única (ya no duplicada en SQL + TS).
create table delivery_tariff_bands (
  band_index          integer primary key,
  max_distance_meters integer not null check (max_distance_meters > 0),
  fee_amount          numeric(10,2) not null check (fee_amount >= 0)
);

-- Cotizaciones standalone (antes de pedido). Sin campo de "cupo": el cupo es
-- rate-limiting del canal (WhatsApp), el dominio no lo sabe.
create table delivery_quote_requests (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid references customers(id) on delete restrict,
  idempotency_key  text not null unique,
  latitude         double precision not null check (latitude between -90 and 90),
  longitude        double precision not null check (longitude between -180 and 180),
  status           text not null check (status in ('quoted','manual_quote','failed')),
  distance_meters  integer check (distance_meters is null or distance_meters >= 0),
  distance_source  text check (distance_source is null or distance_source in ('mapbox','reused')),
  fee_amount       numeric(10,2) check (fee_amount is null or fee_amount >= 0),
  error_code       text,
  created_at       timestamptz not null default now()
);

-- ===== 1700000007000_payments =====
create table payment_attempts (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references orders(id) on delete restrict,
  customer_id    uuid references customers(id),
  opened_at      timestamptz not null default now(),
  opened_as      text not null default 'normal' check (opened_as in ('normal','late')),
  review_status  text not null default 'pending_review'
    check (review_status in ('pending_review','accepted','rejected')),
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint payment_attempts_id_order_unique unique (id, order_id)
);

-- Invariante 6 del plan: como máximo un intento "vivo" por pedido, a nivel
-- de esquema (índice único parcial), no solo en código de aplicación.
create unique index uq_payment_attempts_live
  on payment_attempts (order_id)
  where review_status in ('pending_review', 'accepted');

create table payment_proofs (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid references orders(id) on delete restrict,
  attempt_id            uuid,
  duplicate_of_id       uuid references payment_proofs(id),
  source_message_id     text not null unique,
  match_method          text not null check (match_method in (
    'current_qr_order','attached','duplicate','ambiguous','unresolved'
  )),
  routing_exception     text check (routing_exception is null or routing_exception in (
    'signal_conflict','expired_target','payment_already_accepted','closed_order'
  )),
  capture_status        text not null default 'capturing'
    check (capture_status in ('capturing','stored','failed')),
  capture_attempts      integer not null default 0,
  storage_provider      text not null default 'r2',
  storage_key           text,
  mime_type             text not null,
  byte_size             integer,
  sha256_hex            text,
  analysis_status       text not null default 'pending' check (analysis_status in ('pending','ok','failed')),
  analysis_verdict      text check (analysis_verdict is null or analysis_verdict in ('ok','suspicious','unreadable')),
  analysis_reasons      text[],
  analysis_amount_label text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Invariante "adjudicación completa": un proof con order_id siempre tiene
  -- o una tarea (attempt_id) o un motivo explícito de por qué no la tiene.
  constraint payment_proofs_adjudication_complete check (
    order_id is null or attempt_id is not null or routing_exception is not null
  ),
  constraint payment_proofs_attempt_order_fk
    foreign key (attempt_id, order_id) references payment_attempts (id, order_id)
    match simple
);

create index idx_payment_proofs_order_id on payment_proofs (order_id);
create index idx_payment_proofs_routing_exception
  on payment_proofs (routing_exception)
  where routing_exception is not null;
create index idx_payment_proofs_unassigned
  on payment_proofs (match_method)
  where order_id is null;

-- ===== 1700000008000_promotions =====
create table promotions (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(btrim(name)) between 1 and 80),
  description  text check (description is null or char_length(description) <= 200),
  promo_price  numeric(10,2) not null check (promo_price > 0 and promo_price <= 5000),
  is_active    boolean not null default false,
  starts_at    timestamptz,
  ends_at      timestamptz,
  sort_order   integer not null default 0,
  image_url    text,
  archived_at  timestamptz,
  revision     integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint promotions_archived_not_active check (not (archived_at is not null and is_active))
);

create table promotion_items (
  id            uuid primary key default gen_random_uuid(),
  promotion_id  uuid not null references promotions(id) on delete cascade,
  product_id    uuid not null references products(id) on delete restrict,
  quantity      integer not null check (quantity between 1 and 10),
  unique (promotion_id, product_id)
);

create table order_promotions (
  id                       uuid primary key default gen_random_uuid(),
  order_id                 uuid not null references orders(id) on delete cascade,
  promotion_id             uuid references promotions(id) on delete restrict,
  promotion_name_snapshot  text not null,
  promo_price_snapshot     numeric(10,2) not null check (promo_price_snapshot > 0),
  combo_quantity           integer not null check (combo_quantity between 1 and 10),
  subtotal                 numeric(10,2) not null,
  components_snapshot      jsonb not null check (
    jsonb_typeof(components_snapshot) = 'array' and jsonb_array_length(components_snapshot) >= 2
  ),
  unique (order_id, promotion_id),
  constraint order_promotions_subtotal_matches check (
    subtotal = promo_price_snapshot * combo_quantity
  )
);

-- ===== 1700000009000_operational-settings-and-staff =====
create table operational_settings (
  id                       boolean primary key default true check (id),  -- fila única
  rain_surcharge_enabled   boolean not null default false,
  rain_surcharge_amount    numeric(10,2) not null default 0,
  business_opens_hour      integer not null default 17,
  business_closes_hour     integer not null default 22,
  late_review_closes_hour  integer not null default 23,
  updated_at               timestamptz not null default now()
);

insert into operational_settings (id) values (true);

create table dashboard_users (
  id             uuid primary key default gen_random_uuid(),
  username       text not null unique,
  password_hash  text not null,
  role           text not null check (role in ('admin','kitchen','cashier')),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);

-- ===== 1700000010000_notification-jobs =====
-- Avisos salientes: reemplaza order_notifications + telegram_alerts con una
-- tabla única de "trabajos de aviso", mismo patrón claim->intentar->marcar.

create table notification_jobs (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null,  -- 'order_received' | 'confirmation' |
                                        -- 'location_request' | 'delivery_notice' |
                                        -- 'handoff_notice' | 'late_request_alert' | ...
  channel              text not null check (channel in ('whatsapp','telegram')),
  target_ref           text not null,  -- customer_id, order_id o chat_id según kind
  payload              jsonb not null,
  status               text not null default 'pending'
    check (status in ('pending','sending','sent','failed')),
  claim_token          uuid,
  claimed_until        timestamptz,
  attempts             integer not null default 0,
  next_attempt_at      timestamptz,
  external_message_id  text,
  last_error_code      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint notification_jobs_dedupe unique (kind, target_ref)
);

-- Claim de workers del job de recuperación: solo sobre lo pendiente/fallido
-- que ya puede reintentarse, nunca sobre la tabla completa.
create index idx_notification_jobs_claimable
  on notification_jobs (next_attempt_at)
  where status in ('pending', 'failed');

-- ===== 1700000011000_restaurant-location-and-tariff-seed =====
-- Coordenadas del restaurante: origen para medir distancia de delivery.
-- Separado de la tarifa a propósito (config operativa, no regla de negocio).
alter table operational_settings
  add column restaurant_latitude  double precision,
  add column restaurant_longitude double precision;



-- ===== 1700000012000_delivery-quote-distance-source-straight-line =====
-- Sin Mapbox conectado todavía, la distancia se mide en línea recta
-- (haversine) como MVP — 'straight_line' lo deja explícito en el dato en vez
-- de mentir con 'mapbox'. Swap a distancia real por calle es un cambio de
-- DistanceService, no de esquema.
alter table delivery_quote_requests
  drop constraint if exists delivery_quote_requests_distance_source_check;

alter table delivery_quote_requests
  add constraint delivery_quote_requests_distance_source_check
  check (distance_source is null or distance_source in ('mapbox', 'straight_line', 'reused'));

-- ===== 1700000013000_late-order-request-number-seq =====
create sequence late_order_request_number_seq;

alter table late_order_requests
  alter column request_number
  set default ('SOL-' || lpad(nextval('late_order_request_number_seq')::text, 6, '0'));

-- ===== 1700000014000_payment-proofs-customer-id =====
-- resolveAssociation (portado del sistema anterior) necesita identidad de cliente
-- independiente de order_id (un proof sin pedido asociado todavía sigue
-- necesitando saber de qué cliente es, para el lock por cliente y para
-- detectar duplicados por sha256 antes de que exista adjudicación).
alter table payment_proofs
  add column customer_id uuid references customers(id);

create index idx_payment_proofs_customer_sha
  on payment_proofs (customer_id, sha256_hex)
  where sha256_hex is not null;

create index idx_payment_proofs_customer_routing_exception
  on payment_proofs (customer_id, routing_exception, created_at)
  where routing_exception is not null;

-- ===== 1700000015000_payment-proofs-match-method-extend =====
-- Dominio completo de match_method portado del sistema anterior
-- (0021_payment_proof_routing_methods.sql): agrega los niveles 0/1/2 del
-- algoritmo de asociación (reply_to_qr, single_open_qr_order) y 'manual'
-- (asignación humana vía POST /payment-proofs/:id/assign).
alter table payment_proofs
  drop constraint if exists payment_proofs_match_method_check;

alter table payment_proofs
  add constraint payment_proofs_match_method_check
  check (match_method in (
    'reply_to_qr', 'single_open_qr_order', 'current_qr_order',
    'attached', 'duplicate', 'ambiguous', 'manual', 'unresolved'
  ));

-- ===== 1700000016000_payment-proofs-candidate-count =====
-- Cuántos pedidos QR candidatos vio resolveAssociation al decidir (0, 1 o
-- N). Antes se calculaba y se descartaba — persistirlo permite auditar
-- después por qué un comprobante quedó 'ambiguous' o 'unresolved' sin tener
-- que reconstruir la ventana de tiempo a mano.
alter table payment_proofs
  add column candidate_count integer;

-- ===== 1700000017000_orders-status-updated-by =====
-- El tablero de cocina ahora exige login (JWT, rol kitchen/admin) para
-- cambiar de estado un pedido — se guarda qué staff lo hizo.
alter table orders
  add column status_updated_by text;

-- ===== 1700000018000_enable-rls-on-public-tables =====
--
-- Ninguna tabla tenía RLS activado: en un proveedor que expone una API REST
-- sobre Postgres (PostgREST, ej. Supabase) quedan accesibles para cualquiera
-- con la anon key. En un Postgres común esto es inocuo.
-- Este backend nunca pasa por PostgREST (se conecta directo con pg/Kysely
-- vía DATABASE_URL), así que la política de acceso total va dirigida a
-- CURRENT_USER: como esta migración corre con las mismas credenciales que
-- usa la app (DATABASE_URL), el rol autorizado queda fijado automáticamente
-- al rol real del backend, sea cual sea su nombre. Todo lo demás (anon,
-- authenticated, o cualquier otro rol) queda bloqueado por RLS.
do $$
declare
  tbl text;
begin
  for tbl in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format(
      'create policy backend_full_access on public.%I for all to current_user using (true) with check (true)',
      tbl
    );
  end loop;
end $$;

-- ===== 1700000019000_products-image =====
-- Foto de producto para mostrar en el POS y en el catálogo que consulta el
-- agente de WhatsApp. Se sirve siempre a través del backend
-- (GET /products/:id/image, mismo guard que el resto del catálogo) — nunca
-- una URL directa al bucket, igual que payment-proofs.
alter table products
  add column image_key text null,
  add column image_mime_type text null;

-- ===== 1700000020000_cash-register-sessions =====
-- Caja (turno). El local atiende de un día al otro (ej. 19 a 4) — la caja
-- ES el concepto de "día de negocio": el rango opened_at..closed_at define
-- sin ambigüedad la noche completa, sin inventar una fecha aparte. Cubre
-- efectivo y QR por igual: agrupa cualquier pedido que se confirma pagado
-- durante la sesión, no solo plata física.
create table cash_register_sessions (
  id                        uuid primary key default gen_random_uuid(),
  status                    text not null default 'open' check (status in ('open','closed')),
  opened_at                 timestamptz not null default now(),
  opened_by                 text not null,  -- username, mismo patrón que orders.status_updated_by
  opening_amount            numeric(10,2) not null check (opening_amount >= 0),
  closed_at                 timestamptz null,
  closed_by                 text null,
  counted_cash_amount       numeric(10,2) null,  -- lo que el cajero cuenta físicamente al cerrar
  expected_cash_amount      numeric(10,2) null,  -- opening_amount + ventas cash de la sesión
  cash_difference           numeric(10,2) null,  -- counted - expected
  total_cash_sales_amount   numeric(10,2) null,
  total_qr_sales_amount     numeric(10,2) null,
  total_sales_amount        numeric(10,2) null,  -- cash + qr, sin contar opening_amount
  notes                     text null
);

-- Una sola caja abierta a la vez, mismo patrón que uq_payment_attempts_live.
create unique index uq_cash_register_sessions_single_open
  on cash_register_sessions ((true)) where status = 'open';

alter table orders
  add column register_session_id uuid null references cash_register_sessions(id);

-- ===== 1700000021000_operational-settings-hours-simplify =====
-- El horario real no es fijo (varía ±1h noche a noche), así que deja de ser
-- el límite preciso de apertura/cierre — pasa a ser solo un margen ancho de
-- cordura (ej. "cerrado de 6am a 4pm", para descartar un mensaje a las 10am).
-- Adentro de ese margen, la caja (cash_register_sessions) es la que decide
-- de verdad si se toma el pedido directo o se encola para revisión humana —
-- ver checkoutGateAt en common/time/service-window.ts. Ya no hace falta una
-- tercera hora intermedia: business_closes_hour (el viejo límite
-- open→late_review) se descarta, y late_review_closes_hour (el viejo límite
-- final) pasa a ser el nuevo business_closes_hour.
alter table operational_settings
  drop column business_closes_hour;

alter table operational_settings
  rename column late_review_closes_hour to business_closes_hour;

-- ===== 1700000022000_bank-qr-charges =====
-- QR real del banco (Banco Económico) vinculado 1 a 1 con el payment_attempt
-- que ya usa todo el resto del sistema (decide(), vínculo a caja, CAS). No
-- reemplaza payment_attempts, lo complementa: acá vive el detalle bancario
-- (qrId, imagen, estado del lado del banco) que payment_attempts no necesita
-- conocer.
create table bank_qr_charges (
  id                     uuid primary key default gen_random_uuid(),
  order_id               uuid not null references orders(id) on delete restrict,
  payment_attempt_id     uuid not null,
  qr_id                  text not null unique,
  transaction_id         text not null,
  amount                 numeric(10,2) not null,
  due_date               date not null,
  status                 text not null default 'pending'
    check (status in ('pending','confirmed','cancelled','expired')),
  qr_image_base64        text not null,
  raw_generate_response  jsonb,
  raw_status_response    jsonb,
  raw_notify_payload     jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint bank_qr_charges_attempt_order_fk
    foreign key (payment_attempt_id, order_id)
    references payment_attempts (id, order_id)
);

create index idx_bank_qr_charges_order_id on bank_qr_charges (order_id);
create index idx_bank_qr_charges_pending on bank_qr_charges (status) where status = 'pending';

-- ===== 1700000023000_orders-created-at-index =====
-- La reportería filtra y agrupa pedidos por rango de fechas (created_at) y
-- por turno de caja; sin estos índices cada reporte recorre toda la tabla.
create index if not exists idx_orders_created_at on orders (created_at);
create index if not exists idx_orders_register_session_id on orders (register_session_id);

-- ===== 1700000024000_delivery-type-dine-in =====
-- Nuevo tipo de pedido `dine_in` (para comer en el local, mesa). `pickup`
-- sigue siendo "para llevar desde el mostrador" y `delivery` a domicilio.
alter table orders drop constraint if exists orders_delivery_type_check;
alter table orders add constraint orders_delivery_type_check
  check (delivery_type in ('delivery','pickup','dine_in'));

alter table late_order_requests drop constraint if exists late_order_requests_delivery_type_check;
alter table late_order_requests add constraint late_order_requests_delivery_type_check
  check (delivery_type in ('delivery','pickup','dine_in'));

-- ===== 1700000025000_bank-qr-paid-unapplied =====
-- Pago que el banco confirma pero que no se puede aplicar a su pedido
-- (típicamente: entró después de cerrar la caja de la jornada). La plata YA
-- está en la cuenta, así que no se puede descartar ni aplicar a destiempo —
-- aplicarla al abrir la caja del día siguiente la metería en el cuadre de
-- otra jornada, y el pedido de anoche ya no se va a cocinar. Queda en
-- 'paid_unapplied' para que un humano decida: aplicarlo (si el local sigue
-- abierto) o devolverle la plata al cliente y marcar 'refunded'. El banco no
-- expone ninguna API de devolución (ver manual v1.0.0), así que devolver es
-- siempre manual y esto es solo el registro de que hay que hacerlo.
alter table bank_qr_charges drop constraint if exists bank_qr_charges_status_check;
alter table bank_qr_charges add constraint bank_qr_charges_status_check
  check (status in ('pending','confirmed','cancelled','expired','paid_unapplied','refunded'));

-- Primer instante en que el banco lo reportó pagado sin poder aplicarlo.
-- Da el margen de gracia: mientras esté dentro, el cron sigue reintentando
-- (cubre el cierre de caja de dos minutos por cambio de turno); pasado el
-- margen, escala a 'paid_unapplied' y avisa al staff.
alter table bank_qr_charges add column paid_detected_at timestamptz null;

-- Notas de la resolución manual (quién devolvió, por qué, referencia).
alter table bank_qr_charges add column resolution_notes text null;

create index idx_bank_qr_charges_paid_unapplied on bank_qr_charges (status)
  where status = 'paid_unapplied';

-- ===== 1700000026000_products-description =====
-- Descripción del producto para el catálogo (POS y agente de WhatsApp) —
-- hasta ahora products no tenía ningún campo de texto libre, solo el name.
alter table products add column description text null;

-- ===== 1700000027000_order-number-per-cash-register-session =====
-- order_number pasa a ser solo el número que se le dice/imprime al
-- cliente ("Pedido #5"), y reinicia cada vez que se ABRE la caja — no cada
-- día calendario, porque el turno cruza medianoche (el mismo motivo por el
-- que ya usamos la caja como "día de negocio" en otros lados). Por eso deja
-- de ser único a nivel de base.
--
-- bank_reference toma el rol que tenía order_number de identificador único
-- para siempre: es lo que se manda al banco como transactionId en cada QR
-- real (ver QrPaymentsService.generateForOrder) — si dos pedidos de turnos
-- distintos comparten order_number ("Pedido #1" de hoy y de mañana), NUNCA
-- van a compartir bank_reference, así que el banco jamás ve un
-- transactionId repetido.
alter table orders drop constraint if exists orders_order_number_key;
alter table orders alter column order_number drop default;

alter table orders add column bank_reference text;
alter table orders alter column bank_reference
  set default ('REF-' || lpad(nextval('order_number_seq')::text, 6, '0'));
alter table orders alter column bank_reference set not null;
alter table orders add constraint orders_bank_reference_key unique (bank_reference);

-- Qué apertura de caja ancla la numeración de este pedido — null en los
-- pedidos viejos, de antes de este cambio, y en el caso borde de un pedido
-- creado antes de que exista siquiera una primera sesión de caja.
alter table orders add column numbering_session_id uuid null references cash_register_sessions(id);

-- Contador que cada pedido nuevo incrementa atómicamente
-- (UPDATE ... SET next_order_number = next_order_number + 1 RETURNING ...);
-- arranca en 0 en cada sesión nueva, así el primer pedido del turno es el 1.
alter table cash_register_sessions add column next_order_number integer not null default 0;

-- ===== 1700000028000_split-payment =====
-- Pago dividido (POS presencial): parte efectivo, parte QR, cada monto
-- confirmado por su propio camino existente (cash/confirm y
-- payment-attempts.decide/confirmPresencial) — sin tabla nueva, solo estos
-- tres campos en el pedido. payment_status pasa a 'paid' recién cuando LAS
-- DOS partes están confirmadas (ver OrdersService/PaymentAttemptsService).
alter table orders drop constraint if exists orders_payment_method_check;
alter table orders add constraint orders_payment_method_check
  check (payment_method in ('qr','cash','split'));

alter table orders add column split_cash_amount numeric(10,2) null check (split_cash_amount >= 0);
alter table orders add column split_qr_amount numeric(10,2) null check (split_qr_amount >= 0);
alter table orders add column split_cash_confirmed_at timestamptz null;

-- ===== 1700000029000_product-complements =====
-- Complementos (tomate, lechuga, cebolla, pepinillo, etc.): lista por
-- producto, sin precio propio — solo sirven para excluir ("sin cebolla").
-- Por defecto todos van incluidos; el pedido guarda un snapshot de nombres
-- excluidos por línea (no un id de complemento) porque, igual que
-- product_name_snapshot/unit_price_snapshot, un pedido histórico nunca debe
-- cambiar si después el admin edita o borra el complemento en el catálogo.
create table product_complements (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  name        text not null check (btrim(name) <> ''),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  constraint uq_product_complements_product_name unique (product_id, name)
);

create index idx_product_complements_product_id on product_complements (product_id);

-- Dos líneas del mismo producto con distinta selección de complementos NO
-- se pueden fusionar en una sola fila con más quantity (perderían cuál
-- unidad va "sin cebolla"), así que cada línea guarda su propia exclusión.
alter table order_items
  add column excluded_complements text[] not null default '{}';

-- ===== 1700000030000_delivery-drivers =====
-- Repartidores: nuevo rol `delivery` y asignación de pedidos de delivery.
alter table dashboard_users drop constraint if exists dashboard_users_role_check;
alter table dashboard_users add constraint dashboard_users_role_check
  check (role in ('admin','kitchen','cashier','delivery'));

alter table orders
  add column delivery_driver_id    uuid references dashboard_users (id),
  add column delivery_driver_name  text,
  add column delivery_accepted_at  timestamptz,
  add column delivered_at          timestamptz;

create index idx_orders_delivery_driver_id on orders (delivery_driver_id) where delivery_driver_id is not null;

-- ===== 1700000034000_payment-proof-analysis =====
-- Fase 2D: análisis visual de comprobantes. Aditiva sobre `payment_proofs`
-- (ya migrada en 1700000007000_payments.sql y siguientes). Los hechos
-- estructurados que produce la lectura (banco, cuenta, titular, monto,
-- referencia, fecha) se guardan en un solo JSONB (`analysis_facts`) en vez
-- de una columna por campo: es lo mismo que persiste el sistema anterior
-- (analysis_amount/reference/model/destination_*), reempaquetado para no
-- ensanchar la tabla con columnas mayormente NULL. `analysis_status`,
-- `analysis_verdict`, `analysis_reasons` y `analysis_amount_label` YA
-- existen (1700000007000) y no se tocan.

alter table payment_proofs
  add column analysis_facts jsonb,
  add column analyzed_at timestamptz,
  add column analysis_model text;

alter table payment_proofs
  add constraint payment_proofs_analysis_facts_is_object
    check (analysis_facts is null or jsonb_typeof(analysis_facts) = 'object');

-- Coherencia igual a la del sistema anterior (0025_payment_proof_analysis.sql):
-- 'ok' exige veredicto + instante de análisis; 'pending'/'failed' nunca los
-- llevan (una fila 'failed' significa "no se pudo leer", no "se leyó y no
-- cuadra" — por eso tampoco tiene analysis_facts).
alter table payment_proofs
  add constraint payment_proofs_analysis_coherence check (
    (analysis_status = 'ok' and analysis_verdict is not null and analyzed_at is not null)
    or (analysis_status in ('pending', 'failed') and analysis_verdict is null and analyzed_at is null)
  );

-- Búsqueda de "este número de transacción ya se usó" (referenceReused).
create index idx_payment_proofs_analysis_reference
  on payment_proofs (((analysis_facts ->> 'transactionRef')))
  where analysis_facts ->> 'transactionRef' is not null;

-- ===== 1700000035000_delivery-fee-paid-tristate =====
-- Fase 2E: `delivery_fee_paid` pasa a ser TRIESTADO, igual que en
-- el sistema anterior (0033_delivery_fee_paid_override.sql):
--   NULL  = nadie se pronunció todavía (manda la deducción del pedido/comprobante)
--   true  = una persona marcó "envío pagado"
--   false = una persona marcó "hay que cobrar el envío" (NO es lo mismo que NULL)
-- Antes era `boolean not null default false`, que no podía distinguir "nadie
-- decidió" de "alguien decidió cobrar". Nadie escribía esta columna todavía,
-- así que TODAS las filas existentes son "sin override" y pasan a NULL.

alter table orders alter column delivery_fee_paid drop not null;
alter table orders alter column delivery_fee_paid drop default;

alter table orders add column delivery_fee_paid_at timestamptz;

alter table orders
  add constraint orders_delivery_fee_paid_coherence check (
    (delivery_fee_paid is null and delivery_fee_paid_at is null)
    or (delivery_fee_paid is not null and delivery_fee_paid_at is not null)
  );

-- ===== 1700000037000_delivery-quote-surcharge =====
-- La cotización sin pedido (POST /delivery/quotes) ahora incluye el recargo por
-- lluvia vigente al momento de cotizar: se guarda para que una respuesta
-- repetida (misma Idempotency-Key) devuelva el mismo monto aunque el recargo
-- cambie después. Filas anteriores quedan en null (= sin recargo).
alter table delivery_quote_requests
  add column surcharge_amount numeric(10,2)
    check (surcharge_amount is null or surcharge_amount >= 0);

-- ===== 1700000038000_order-replacement =====
-- FASE 3: "modificar mi pedido" (replace-not-mutate). Nunca se editan las
-- líneas de un pedido existente: uno nuevo reemplaza al viejo, vinculados acá.
alter table orders
  add column replaces_order_id    uuid references orders (id),
  add column replaced_by_order_id uuid references orders (id);

-- Un pedido viejo solo puede ser reemplazado UNA vez — barrera extra además
-- del `select ... for update` que ya toma el replacement en la misma fila.
create unique index uq_orders_replaced_by_order_id
  on orders (replaced_by_order_id) where replaced_by_order_id is not null;

-- "Último pedido activo de un cliente": ya existían idx_orders_customer_id e
-- idx_orders_status por separado, pero no un compuesto para
-- `where customer_id = ? and status not in ('cancelled','delivered')
--  order by created_at desc limit 1`.
create index idx_orders_customer_active on orders (customer_id, created_at desc)
  where status not in ('cancelled', 'delivered');

-- ===== 1700000039000_order-replacement-correctness =====
-- Correctivo de 1700000038000: esa migración ya pudo estar aplicada en un
-- entorno desplegado, así que esta NO la toca — solo agrega lo que faltaba.
--
-- "Un pedido viejo solo puede tener un replacement" es una restricción
-- sobre replaces_order_id (la columna del pedido NUEVO que apunta al
-- viejo) — la unique de 038 vive en replaced_by_order_id (la columna del
-- pedido VIEJO), que en cambio garantiza "un pedido nuevo no es el
-- replacement de más de un viejo". Mantenemos ambas: juntas hacen la
-- relación estrictamente 1:1 en los dos sentidos.
create unique index if not exists uq_orders_replaces_order_id
  on orders (replaces_order_id) where replaces_order_id is not null;

-- Down Migration
-- Baseline: no hay vuelta atrás parcial. Para empezar de cero, recrear la base.
