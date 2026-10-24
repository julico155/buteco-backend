-- Up Migration
-- Saldo prepago del negocio y comisión sobre los pedidos del agente (canal whatsapp).
--
-- El negocio recarga saldo pagando un QR (con otro juego de llaves del banco) y cada pedido del agente cobrado por QR descuenta
-- una comisión sobre el subtotal (los productos, sin envío). Todo se apoya en un libro de movimientos que solo crece: el saldo
-- es la suma, nunca se edita ni se borra una fila, y cada movimiento ligado a un pedido o a una recarga ocurre una sola vez.
--
-- ADITIVA: tablas nuevas y dos columnas nulables en `orders`. Un pedido sin comisión (todos los anteriores, y cualquiera mientras
-- AGENT_COMMISSION_PERCENT no esté definida) tiene ambas columnas en null y se comporta igual que antes.

-- Recargas de saldo: un QR por recarga, mismo ciclo de vida que `bank_qr_charges`.
create table balance_topups (
  id               uuid primary key default gen_random_uuid(),
  amount           numeric(12,2) not null check (amount > 0),
  status           text not null default 'pending'
    check (status in ('pending','confirmed','expired','cancelled')),
  qr_id            text not null unique,
  transaction_id   text not null unique,
  due_date         date not null,
  qr_image_base64  text not null,
  raw_generate_response jsonb,
  raw_status_response   jsonb,
  created_by       text,
  paid_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Barrido de recargas pendientes (el cron mira solo estas).
create index idx_balance_topups_pending on balance_topups (created_at) where status = 'pending';

-- Libro de movimientos. `amount` lleva signo: recarga y reverso suman, comisión resta, el ajuste puede ser cualquiera.
create table balance_ledger (
  id          uuid primary key default gen_random_uuid(),
  type        text not null check (type in ('topup','commission','commission_reversal','adjustment')),
  amount      numeric(12,2) not null check (amount <> 0),
  order_id    uuid references orders(id) on delete restrict,
  topup_id    uuid references balance_topups(id) on delete restrict,
  note        text,
  created_by  text,
  created_at  timestamptz not null default now(),
  -- Cada tipo apunta a lo suyo: una comisión (y su reverso) a un pedido, una recarga a su QR, un ajuste a nada.
  constraint balance_ledger_type_target check (
    (type in ('commission','commission_reversal') and order_id is not null and topup_id is null)
    or (type = 'topup' and topup_id is not null and order_id is null)
    or (type = 'adjustment' and order_id is null and topup_id is null)
  ),
  constraint balance_ledger_sign check (
    (type in ('topup','commission_reversal') and amount > 0)
    or (type = 'commission' and amount < 0)
    or type = 'adjustment'
  )
);

-- Una comisión y un reverso por pedido, una recarga por QR: lo que hace seguro reintentar. (Los null no chocan entre sí.)
create unique index uq_balance_ledger_order_type on balance_ledger (order_id, type);
create unique index uq_balance_ledger_topup_type on balance_ledger (topup_id, type);
create index idx_balance_ledger_created on balance_ledger (created_at desc);

-- Estado del aviso de saldo bajo: una sola fila. Evita avisar en cada vuelta del cron y sobrevive a un reinicio.
create table billing_state (
  id                    boolean primary key default true check (id),
  low_balance_notified  boolean not null default false,
  updated_at            timestamptz not null default now()
);
insert into billing_state (id) values (true);

-- Comisión congelada al crear el pedido: cambiar la variable de entorno no altera pedidos ya hechos.
alter table orders
  add column agent_commission_percent numeric(5,2)
    check (agent_commission_percent is null or (agent_commission_percent > 0 and agent_commission_percent <= 100)),
  add column agent_commission_amount  numeric(10,2)
    check (agent_commission_amount is null or agent_commission_amount > 0);

alter table orders
  add constraint orders_agent_commission_pair
    check ((agent_commission_percent is null) = (agent_commission_amount is null));

-- Pedidos abiertos con comisión pendiente de descontar (lo que "reserva" saldo): el filtro del bloqueo.
create index idx_orders_commission_pending on orders (channel)
  where agent_commission_amount is not null and payment_status = 'unpaid';

-- Down Migration
drop index if exists idx_orders_commission_pending;
alter table orders drop constraint if exists orders_agent_commission_pair;
alter table orders
  drop column if exists agent_commission_amount,
  drop column if exists agent_commission_percent;
drop table if exists billing_state;
drop table if exists balance_ledger;
drop table if exists balance_topups;
