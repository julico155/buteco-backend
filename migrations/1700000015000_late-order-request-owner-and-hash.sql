-- Up Migration
-- M7A: recuperar de forma segura el resultado de un pedido fuera de horario (HTTP 202).
--
-- Hasta ahora la `Idempotency-Key` de `late_order_requests` era única A SECAS: dos servicios con la misma clave se pisaban
-- (uno recibía la solicitud del otro) y un reintento con otro carrito devolvía la solicitud vieja sin error. Esta
-- migración, ADITIVA salvo por el índice único:
--   - `api_client`: qué servicio creó la solicitud. La clave pasa a ser única POR servicio, igual que en `idempotency_keys`.
--   - `request_hash`: huella del cuerpo (la misma de la idempotencia general), para rechazar con 409 un reintento con otro
--     contenido. Nulo en las solicitudes anteriores: ahí se cae a la comparación de ubicación de siempre.
--
-- Las solicitudes existentes se rellenan por canal (el canal sale de la credencial: whatsapp -> whatsapp-gateway, web -> web,
-- pos -> pos), así un reintento sobre una solicitud pendiente de antes de la migración la sigue encontrando.

alter table late_order_requests
  add column if not exists api_client   text,
  add column if not exists request_hash text;

update late_order_requests
   set api_client = case channel
     when 'whatsapp' then 'whatsapp-gateway'
     else channel
   end
 where api_client is null;

alter table late_order_requests
  drop constraint if exists late_order_requests_idempotency_key_key;

create unique index if not exists uq_late_order_requests_client_key
  on late_order_requests (api_client, idempotency_key);

-- Down Migration
-- Volver a la unicidad global puede fallar si dos servicios ya usaron la misma clave: en ese caso hay que resolver los
-- duplicados a mano antes de bajar.
drop index if exists uq_late_order_requests_client_key;

alter table late_order_requests
  add constraint late_order_requests_idempotency_key_key unique (idempotency_key);

alter table late_order_requests
  drop column request_hash,
  drop column api_client;
