-- Up Migration
-- Ubicación en solicitudes fuera de horario (HTTP 202): también para el servicio `whatsapp-gateway`.
--
-- La migración 1700000013000 restringió las coordenadas a `channel = 'web'`. Desde M6A.1 el servicio `whatsapp-gateway`
-- (credencial de servidor compartida por el menú web y el agente) también puede mandar `deliveryLocation` al crear, y su
-- pedido conserva el canal `whatsapp`. Esta migración, ADITIVA y posterior, sustituye solo esa restricción por una que admite
-- ambos canales con servicio autorizado y mantiene lo demás: solo delivery, ni POS ni `external`. No toca datos ni columnas.

alter table late_order_requests
  drop constraint if exists late_order_requests_delivery_location_web_delivery;

alter table late_order_requests
  add constraint late_order_requests_delivery_location_channel_delivery
    check (delivery_latitude is null or (channel in ('web', 'whatsapp') and delivery_type = 'delivery'));

-- Down Migration
alter table late_order_requests
  drop constraint late_order_requests_delivery_location_channel_delivery;

alter table late_order_requests
  add constraint late_order_requests_delivery_location_web_delivery
    check (delivery_latitude is null or (channel = 'web' and delivery_type = 'delivery'));
