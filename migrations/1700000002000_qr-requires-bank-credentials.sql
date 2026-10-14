-- Up Migration
-- Regla de pagos: no se puede ACTIVAR una forma de pago con QR (qr / split)
-- si el banco no tiene credenciales configuradas, para no ofrecerle al
-- cliente un QR que el backend no puede generar. Es un toggle porque un
-- restaurante que cobra el QR "a ojo" (comprobante manual, sin API del banco)
-- necesita poder prenderlo igual.
alter table operational_settings
  add column qr_requires_bank_credentials boolean not null default true;

-- Down Migration
alter table operational_settings drop column if exists qr_requires_bank_credentials;
