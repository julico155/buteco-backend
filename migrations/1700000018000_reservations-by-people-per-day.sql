-- Up Migration
-- Las reservas dejan de depender de las mesas: el cupo pasa a ser un máximo de PERSONAS por día.
--
-- Hasta ahora cada reserva bloqueaba una mesa concreta (la más chica que alcanzara) y la disponibilidad salía de los asientos de
-- las mesas. El local pasa a vender "mesa" como un pedido simple (sin plano ni cuentas abiertas), así que la reserva solo cuenta
-- cuánta gente se comprometió ese día: la suma de `party_size` de las reservas vivas no puede pasar de `max_people_per_day`.
--
-- ADITIVA: `table_id` pasa a admitir null (las reservas de antes conservan su mesa; las nuevas no la usan) y se agrega un ajuste.
-- No se borra ninguna columna ni tabla: las mesas y los pisos quedan en la base, solo que las reservas ya no los miran.

alter table reservations alter column table_id drop not null;

alter table reservation_settings
  add column max_people_per_day integer not null default 30
    check (max_people_per_day between 1 and 1000);

-- Down Migration
-- Volver a exigir `table_id` falla si ya hay reservas sin mesa: hay que asignarles una (o borrarlas) antes de bajar.
alter table reservation_settings drop column max_people_per_day;
alter table reservations alter column table_id set not null;
