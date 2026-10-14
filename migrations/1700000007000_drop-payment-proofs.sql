-- Up Migration
-- Sin comprobantes por foto: el único cobro con QR es la API del banco.
--
-- payment_proofs guardaba la foto que mandaba el cliente y cómo se asoció a
-- un pedido. Sin ese flujo la tabla no tiene escritor ni lector. Atención:
-- BORRA el historial de comprobantes de la instancia (los archivos del bucket
-- no se tocan). Si el restaurante necesita conservarlos, exportar la tabla
-- antes de migrar.
--
-- qr_requires_bank_credentials: el toggle existía para poder cobrar QR "por
-- comprobante manual" sin API del banco. Sin comprobantes, apagarlo solo
-- permitiría activar un QR que nunca se confirma: la regla pasa a ser fija
-- (QR/split exigen credenciales del banco, salvo POS en modo manual).
drop table if exists payment_proofs;

alter table operational_settings
  drop column if exists qr_requires_bank_credentials;

-- Down Migration
-- payment_proofs no se restaura (los datos no se pueden reconstruir); se
-- recupera el toggle con su default.
alter table operational_settings
  add column if not exists qr_requires_bank_credentials boolean not null default true;
