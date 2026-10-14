-- Up Migration
-- Tres reglas que estaban fijas en el código pasan a configuración.
--
-- manual_quote_max_amount: tope del monto que el staff puede fijar a mano en
-- una cotización de delivery manual (antes un 500 literal en el servicio).
--
-- payment_options.channels: canales de origen que pueden usar esa forma de
-- pago (antes: "WhatsApp solo QR o efectivo" cableado en el código). Los
-- defaults reproducen esa regla: split solo desde POS y web, porque en
-- WhatsApp no hay nadie presente para dividir el cobro.
--
-- cash_prepayment_required: si es true, un pedido en efectivo de pickup o mesa
-- necesita estar pagado (confirmado por el cajero) antes de pasar a
-- `preparing`, igual que QR y split. El efectivo de delivery no se ve
-- afectado: lo cobra el repartidor al entregar. Antes: siempre false.
alter table operational_settings
  add column manual_quote_max_amount numeric(10,2) not null default 500
    check (manual_quote_max_amount > 0),
  add column cash_prepayment_required boolean not null default false;

alter table payment_options
  add column channels text[] not null default array['pos','whatsapp','web']::text[],
  add constraint payment_options_channels_valid
    check (cardinality(channels) > 0 and channels <@ array['pos','whatsapp','web']::text[]);

update payment_options set channels = array['pos','web']::text[]
where payment_method = 'split';

-- Down Migration
alter table payment_options
  drop constraint if exists payment_options_channels_valid,
  drop column if exists channels;

alter table operational_settings
  drop column if exists cash_prepayment_required,
  drop column if exists manual_quote_max_amount;
