-- Up Migration

-- Visibilidad por canal: en qué canal se vende cada producto SUELTO y cada
-- promoción (menú web/WhatsApp vs POS). Un producto apagado en un canal aún
-- puede venderse dentro de un combo de ese canal (los componentes no miran
-- estos flags). Default true: los productos/promos nuevos salen en ambos menús.
alter table products
  add column if not exists sell_on_whatsapp boolean not null default true,
  add column if not exists sell_on_pos boolean not null default true;

alter table promotions
  add column if not exists sell_on_whatsapp boolean not null default true,
  add column if not exists sell_on_pos boolean not null default true,
  -- true: la promo se puede combinar con productos sueltos (y otras promos).
  -- false: el pedido con esta promo solo puede llevar promociones, sin sueltos.
  add column if not exists allow_combine_with_loose boolean not null default true;

-- Down Migration
alter table promotions
  drop column if exists allow_combine_with_loose,
  drop column if exists sell_on_pos,
  drop column if exists sell_on_whatsapp;
alter table products
  drop column if exists sell_on_pos,
  drop column if exists sell_on_whatsapp;
