# Seeds por restaurante

> Los seeds son **opcionales**: la ubicación del local se carga con
> `PATCH /operational-settings` y las bandas con `PUT /delivery/tariff-bands`.
> El seed es un atajo por SQL.

Los datos propios de cada restaurante (ubicación del local, bandas de tarifa
de delivery) **no** van en `migrations/`: las migraciones son esquema y se
aplican igual en todos los despliegues. Acá vive un seed por restaurante.

1. `npm run migrate:up`
2. Copiar `example-restaurant.sql` como `seeds/<restaurante>.sql` y ajustar.
3. Correrlo una vez contra la base de ese restaurante.
