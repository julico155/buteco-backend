-- Up Migration
-- Quedan solo dos roles: admin y cashier. No hay pantalla de cocina ni app de
-- repartidor (el aviso de delivery va al grupo de Telegram).
--
-- Los usuarios kitchen/delivery que existieran se dejan DESACTIVADOS como
-- cashier (no se borran: pueden estar referenciados por pedidos viejos).
-- Desactivarlos primero evita que un repartidor herede de golpe acceso a caja.
update dashboard_users
   set is_active = false,
       role = 'cashier'
 where role in ('kitchen', 'delivery');

alter table dashboard_users drop constraint if exists dashboard_users_role_check;
alter table dashboard_users add constraint dashboard_users_role_check
  check (role in ('admin','cashier'));

-- Down Migration
alter table dashboard_users drop constraint if exists dashboard_users_role_check;
alter table dashboard_users add constraint dashboard_users_role_check
  check (role in ('admin','kitchen','cashier','delivery'));
