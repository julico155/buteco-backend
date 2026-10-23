# Backend de Buteco (basado en la plantilla restaurant-backend-base)

> **Buteco — cambios sobre la plantilla (fase 1).** Solo hay dos roles de
> staff, `admin` y `cashier`; no existen `kitchen` ni `delivery`. La cocina
> trabaja con la comanda impresa, así que un pedido se cierra en un paso:
> recojo y mesa -> `delivered` (entregado), delivery -> `out_for_delivery`
> (despachado, sin confirmación de entrega). `preparing` y `ready` ya no se
> alcanzan. El aviso de delivery sigue yendo al grupo de Telegram. Los pedidos
> que nadie cierra se cierran solos a las `STALE_ORDER_CLOSE_HOURS` (12 h).
> Horario: martes a domingo, abre 12:00; lo que entra por WhatsApp o la web se
> rechaza (`409 closed`) fuera de día/hora: delivery hasta 22:50 y recojo hasta
> 22:30 (configurable en `/operational-settings`). El POS no se bloquea. Mesas y
> cuentas abiertas: [docs/mesas.md](docs/mesas.md). Reservas con adelanto por QR:
> [docs/reservas.md](docs/reservas.md). Despliegue en Dokploy:
> [docs/DESPLIEGUE-DOKPLOY.md](docs/DESPLIEGUE-DOKPLOY.md).
> Varios documentos de `docs/` todavía describen la plantilla original.

NestJS + Postgres. Base reutilizable: cada restaurante despliega su propia
instancia y adapta las reglas de negocio por configuración (ver
[docs/NUEVO-RESTAURANTE.md](docs/NUEVO-RESTAURANTE.md)), sin tocar código.

## Setup

```bash
npm install
cp .env.example .env   # completar DATABASE_URL (cadena de conexión a un
                        # Postgres propio, con credenciales propias) y
                        # los demás valores
npm run migrate:up     # aplica migrations/ contra DATABASE_URL
                        # ubicación del local y bandas: por API (ver abajo);
                        # un seed por SQL es opcional (seeds/README.md)

# Primer usuario de staff. POST /auth/users exige un admin ya logueado, así
# que el arranque en frío va por acá (la contraseña sale de ADMIN_PASSWORD
# para no dejarla en el historial del shell).
ADMIN_PASSWORD='...' npm run create-admin -- <username> admin

npm run start:dev
```

**Sin terminal ni acceso a la base** (Dokploy, Railway): el `nixpacks.toml`
migra y arranca solo, y el primer admin se crea con `BOOTSTRAP_ADMIN_PASSWORD`
(y opcionalmente `BOOTSTRAP_ADMIN_USERNAME`) la primera vez que arranca; ver
[docs/NUEVO-RESTAURANTE.md](docs/NUEVO-RESTAURANTE.md).

`CORS_ORIGINS` tiene que incluir el origen de cualquier front en el navegador
(POS, dashboard) o el preflight falla; los clientes que no son navegadores no
lo necesitan. En desarrollo, `http://localhost:5173`.

## Contrato de la API

`/docs` (Swagger UI) y `/docs-json` (OpenAPI) se generan solos desde los tipos
de TypeScript, vía el CLI plugin de `@nestjs/swagger` declarado en
`nest-cli.json`. El front genera sus tipos de request desde `/docs-json` con
`openapi-typescript` en vez de mantenerlos a mano.

**Limitación actual**: los tipos de *response* (`OrderResponse`,
`ProductResponse`, etc.) son `interface`s de TypeScript, que no existen en
runtime — el plugin no puede generar su schema y salen como `object` vacío en
el OpenAPI. Para que el front también genere las respuestas habría que
convertirlas en `class` con `@ApiProperty()`.

## Estructura

- `migrations/` — `1700000000000_baseline.sql`: esquema completo, sin datos de
  ningún restaurante. Las migraciones nuevas se agregan encima con
  `npm run migrate:create`.
- `seeds/` — datos propios de cada restaurante (ubicación del local, bandas
  de tarifa de delivery). Ver `seeds/README.md`.
- `src/database/` — `Kysely<Database>` tipado sobre `pg`, inyectable como
  `KYSELY` en cualquier servicio.
- `src/common/` — guard de auth entre servicios (bearer token estático por
  `api_client`, comparación timing-safe), `IdempotencyService` genérico
  (header `Idempotency-Key`), excepciones/filtro de dominio (`{code,
  message, details}`, nunca texto crudo de Postgres).
- `src/auth/` — login JWT (`dashboard_users`, bcrypt) para sesión de staff,
  `JwtAuthGuard` + `RolesGuard` + `@Roles(...)` para RBAC. Dos capas de auth
  conviven sobre el mismo header `Authorization: Bearer`:
  `ServiceAuthGuard` (bearer estático, tokens de `SERVICE_AUTH_TOKENS`)
  autentica de qué sistema viene la llamada (whatsapp-gateway, pos, web);
  `JwtAuthGuard` autentica qué persona de staff la hizo. Tres casos:
  - **Solo servicio** — lo que solo llama el gateway de WhatsApp
    (`/delivery`, `location`, `switch-to-pickup`).
  - **Solo JWT** — decisiones humanas con rol (mantenimiento de menú,
    tablero de cocina, aceptar/rechazar pedidos tardíos, cobro QR presencial).
  - **Cualquiera de los dos** (`ServiceOrStaffAuthGuard`) — lo que llaman
    tanto el gateway como el POS: catálogo, `POST /orders`, `GET /orders/:id`,
    cobro en efectivo, clientes. Existe para que el POS en el navegador use
    solo la sesión del cajero y no tenga que embeber un token de servicio,
    que no vence, en el bundle. Una request autenticada por JWT queda marcada
    con `apiClient = 'pos'`, que es el scope de idempotencia de
    `POST /orders`.
- `src/gateway-client/` — cliente HTTP hacia el "gateway API" que expondrá
  el gateway de mensajería (`/gateway/whatsapp/messages`, `/gateway/whatsapp/
  location-requests`, `/gateway/telegram/alerts`).
- `src/notifications-out/` — tabla única de trabajos de aviso
  (`notification_jobs`): camino rápido de envío inmediato +
  `NotificationRecoveryCron` (cada minuto) que reintenta con backoff
  exponencial lo que quedó `pending`/`failed`.
- Un módulo por dominio de negocio (`categories`, `products`, `customers`,
  `promotions`, `operational-settings`, `orders`, `delivery`,
  `payment-attempts`, `late-order-requests`, `auth`,
  `cash-register`, `baneco`, `bank-qr`, `reports`).

## Qué está implementado

Todo lo siguiente está implementado, probado con tests unitarios/integración
y verificado manualmente de punta a punta contra un Postgres de
prueba (categorías → productos → cliente → pedido → delivery → cobro por QR
→ confirmación de pago → aviso), incluyendo el gateway de WhatsApp/Telegram
simulado:

- **`categories`, `products`, `customers`, `promotions`** (CRUD completo,
  `status` calculado), **`operational-settings`** (horario, recargo por
  lluvia, coordenadas del restaurante). Escritura protegida por JWT +
  `@Roles('admin')` (disponibilidad de producto también admite `kitchen`).
  `GET /categories` y `GET /products` filtran los inactivos por defecto
  (lo que consume el catálogo de venta); `?includeInactive=true` los trae
  también, para el mantenimiento de menú (poder reactivarlos).
  `products` incluye foto: `POST /products/:id/image` (JWT, rol `admin`,
  base64 en el body, máx. 5 MB, reemplaza la anterior)
  y `GET /products/:id/image` (mismo guard que el catálogo, `imageUrl` en
  `ProductResponse` es la ruta relativa o `null`) — se sirve siempre a
  través del backend, nunca una URL directa al bucket. Storage intercambiable (S3/R2 o disco
  local) según `STORAGE_S3_*`.
  **Complementos** (`product_complements`, ej. tomate/lechuga/cebolla/
  cebolla): lista por producto, sin precio propio (solo exclusión).
  `complements[]` en `POST/PATCH /products` reemplaza la lista completa
  (mismo patrón que `promotions.items`); `ProductResponse.complements[]`
  siempre viene en el catálogo, para que el cliente sepa qué se puede
  destildar.
- **`orders`** — `POST /orders` flujo completo:
   gate de horario en dos capas, porque el horario real no es fijo
  (varía ±1h noche a noche). `business_opens_hour`/`business_closes_hour`
  en `operational_settings` (hora de La Paz, el turno puede cruzar
  medianoche — ej. 19 a 4, comparado relativo a la apertura, no horas
  absolutas del día) son solo un margen ANCHO de cordura para descartar de
  una un mensaje fuera de cualquier horario plausible (ej. cerrado 6am-4pm).
  Adentro de ese margen, la caja abierta (`cash-register`, abajo) decide si
  el pedido se confirma directo o se encola (`late_order_requests`) — ver
  `common/time/service-window.ts`. `Idempotency-Key` genérica reemplazando
  sesión+fingerprint, recálculo de precios/disponibilidad en servidor,
  snapshot de productos y combos, `product_unavailable` vs
  `promotion_unavailable`. Más `location` (dispara cotización de delivery),
  `kitchen-note`, `switch-to-pickup`, `cash/confirm`/`cash/cancel`,
  `PATCH /status` (transición legal + CAS optimista, requiere JWT +
  rol `kitchen`/`admin` y guarda `status_updated_by`; bloquea
  `confirmed → preparing` con `409 payment_required` si `payment_status`
  no es `paid` — para QR y split siempre; el efectivo queda exento
  (se cobra al final) salvo que `cashPrepaymentRequired` esté prendido, y
  entonces solo para pickup y mesa: el efectivo de delivery lo cobra el
  repartidor al entregar),
  `GET /orders` (tablero de cocina/cuadre de caja, rol `kitchen`/
  `cashier`/`admin`) con filtros (`customer_id`, `status`,
  `delivery_type`, `payment_status`) + paginación (`limit`/`offset`) —
  `delivery_type=delivery&payment_status=unpaid` es la cola de "cuadre con
  las motos" a fin de noche. `GET /orders/:id` (un solo pedido) sigue con
  el token de servicio o cualquier JWT. `cash/confirm` y la decisión QR que
  marca `accepted` vinculan el pedido a la caja abierta en ese momento (ver
  `cash-register` abajo) — exigen que haya una.

  **Complementos por línea**: `items[].excludedComplements` (nombres a
  sacar, ej. `["cebolla"]`) — por defecto todos van incluidos. Dos líneas
  del mismo `productId` son válidas si difieren en la selección (ej. "3
  normales + 1 sin cebolla" son dos `order_items`, nunca se fusionan
  porque perderían cuál unidad lleva qué); repetir la misma combinación en
  dos líneas da `400 validation_error`, y un nombre que el producto no
  tiene da `400 unknown_complement`. Snapshot en
  `order_items.excluded_complements` (texto, no id — igual que
  `product_name_snapshot`, no se recalcula si después el admin edita el
  catálogo).

  **`POS_QR_MODE=manual`** (variable de entorno, mientras el banco no
  habilite producción del QR): para `channel='pos'` únicamente,
  `POST /orders/:id/qr/generate` responde `409 qr_manual_mode` en vez de
  llamarlo — el front del POS no muestra ningún QR generado por el sistema;
  el cajero verifica el pago a ojo (con su propio QR, fuera del sistema) y
  confirma con `POST /orders/:id/payment-attempts/confirm-presencial`
  (`{decision: "accepted"}`), que ya soportaba crear+decidir sin que exista
  un `payment_attempt` previo. `notifyOrderCreated` tampoco intenta generar
  el QR real ni le manda nada al cliente por WhatsApp para esos pedidos.
  WhatsApp no se toca — sigue con el QR real de Baneco siempre. Sin la
  variable (o con cualquier otro valor), comportamiento normal. Cuando el
  banco apruebe producción, se saca la variable del entorno de despliegue — sin tocar
  código ni mergear ramas.

  **Qué cobra el QR**: con `paymentMethod: 'qr'` el monto (por
  `QrPaymentsService`, ver `qrChargeAmount`) es `subtotal_amount`, salvo en
  un delivery con `qr_scope = 'food_and_delivery'`, donde es `total_amount`
  (el pedido tiene que estar cotizado: `409 delivery_not_quoted`). Con
  `food_only` — o en presencial — el envío, si lo hay, sigue siendo cobro del
  repartidor, fuera del sistema. Ver `payment-options` abajo.

  **Pago dividido (POS presencial)**: `POST /orders/:id/split-payment`
  (JWT, `cashier`/`admin`; body `{cashAmount, qrAmount}`, deben sumar
  exacto `total_amount` o `400`) pasa `payment_method` a `'split'`. Cada
  pata se confirma con el endpoint que ya existía para ese método
  (`cash/confirm`/`cash/cancel` para la pata efectivo —
  `split_cash_confirmed_at`, columna propia, nunca `cash_confirmed_at` —, y
  `qr/generate`/`confirm-presencial` para la pata QR, cobrando
  `split_qr_amount` en vez de `subtotal_amount`). `payment_status` pasa a
  `'paid'` recién cuando **las dos** patas están confirmadas, en cualquier
  orden; cancelar la pata efectivo vuelve todo a `'unpaid'` aunque la QR ya
  estuviera aceptada. El cierre de caja (`cash-register`, abajo) reparte
  el `total_amount` de un split entre efectivo y QR usando
  `split_cash_amount`/`split_qr_amount`, no lo cuenta entero de un lado.
- **`delivery`** — bandas de tarifa por distancia, que carga el seed de cada restaurante
  (el techo automático es la última banda → `pending_manual`, recargo por lluvia
  congelado en la misma transacción). Distancia vía `DistanceService`
  intercambiable: `MapboxDistanceService` (Directions API, perfil driving)
  ya implementado y se activa solo con `MAPBOX_ACCESS_TOKEN` en `.env`; sin
  token (o si la API falla/tarda más de 4s) usa línea recta (`Haversine`)
  automáticamente — el `distance_source` persistido siempre refleja cuál se
  usó de verdad. Las bandas las edita el admin: `GET` / `PUT
  /delivery/tariff-bands` (JWT `admin`). `PUT` reemplaza la tabla completa en
  una transacción, `band_index` sale de la posición y las distancias tienen
  que crecer (si no, `400 validation_error` sin escribir nada).
- **`late-order-requests`** — `accept`/`reject` requieren JWT + rol `admin`
  o `cashier` (`decidedBy` es el username del staff autenticado, no un
  api_client de servicio). `accept` exige una caja abierta (un pedido fuera
  de horario se vincula a la sesión ahí mismo, sea cash o QR — es el
  momento en que entra oficialmente al turno) y revalida el carrito
  completo reusando `OrdersService.createOrderInTransaction` (con
  `SAVEPOINT` propio) y solo entonces marca `accepted` con su `order_id`;
  fallos permanentes quedan `rejected` con motivo, nunca en bucle; sin caja
  abierta tira `409 cash_register_closed` sin tocar nada — la solicitud
  sigue `pending` para reintentar. `GET /late-order-requests` lista la cola
  (`pending` por defecto) para el dashboard.
- **`payment-attempts`** — CAS puro `pending_review → accepted|rejected`
  con el índice único parcial como garantía de esquema. Cuando el CAS lo
  gana ESTA llamada (`won: true`), en la misma transacción propaga a
  `orders.payment_status` (`paid`/`rejected`) y dispara un aviso best-effort
  al cliente — nunca si `won: false`, para no duplicar el efecto.
  `POST /orders/:id/payment-attempts/confirm-presencial` (JWT, rol
  `cashier`/`admin`) es el fallback manual del cobro QR en el mostrador: si
  ya hay un intento vivo (lo normal, dejado por `QrPaymentsService` al
  generar el QR real) decide sobre ese; si no, crea y decide en un solo
  paso. Sigue protegido por el mismo índice único
  (`uq_payment_attempts_live`), así que no se puede confirmar dos veces ni
  pisar un intento por foto que haya llegado casi al mismo tiempo.
- **`agent-locations`** — `POST /internal/agent/locations/attach` (solo
  api_client `whatsapp-gateway`): el agente manda teléfono + coordenadas +
  `sourceMessageId` y Central resuelve el pedido (`attached`,
  `already_attached`, `location_conflict`, `ambiguous_order`, `no_order`; sin ningún pedido esperando ubicación siempre es `no_order`),
  todo con el pedido bloqueado en una transacción y sin sobrescribir jamás
  una ubicación ya cotizada (misma regla en `POST /orders/:id/location`).
  Teléfonos normalizados con `normalizePhone` (`+<dígitos>`, sin asumir país).
  `POST /delivery/quotes` (cotizar sin pedido) suma el recargo por lluvia y
  devuelve `feeAmount`/`surchargeAmount`/`totalAmount`.
- **`delivery-drivers`** — pantalla del repartidor (rol `delivery`):
  `GET /delivery/orders/available|mine`, `POST /delivery/orders/:id/accept`
  (solo estando a menos de `DELIVERY_ACCEPT_RADIUS_METERS` del local, con CAS
  contra dos repartidores a la vez) y `POST .../deliver`. Cocina ya no mueve
  un delivery a `out_for_delivery`/`delivered`. `available` manda
  `latitude`/`longitude`/`mapsUrl` de cada pedido (nombre/teléfono del
  cliente siguen ocultos hasta aceptar) más `nearbyOrders[]` — distancia
  entre pedidos disponibles entre sí, a menos de
  `DELIVERY_NEARBY_RADIUS_METERS`, para no obligar a comparar pines a ojo.
  Detalle en `docs/delivery-drivers-integration.md`.
- **`reports`** — reportería y KPIs, solo lectura. `admin` ve todo;
  `cashier` y `kitchen` ven `kpis`, `sales/timeseries` y `products/top`, y
  `cashier` además la lista y el detalle de ventas
  (`GET /reports/kpis|sales/timeseries|sales/orders|sales/orders/:id|
  products/top|cash-sessions`). "Vendido" = pagado y no cancelado, fechas en
  hora de Bolivia, y `session_id` para cuadrar contra el cierre de caja. Sin
  tablas nuevas; no hay tiempos de preparación por etapa porque no existe
  historial de estados. Detalle en `docs/reports-integration.md`.
- **`cash-register`** — apertura/cierre de caja (turno). Una sola sesión
  `status='open'` a la vez para todo el local (índice único parcial), rol
  `admin`/`cashier` (`POST /cash-register/sessions/open|close`, `GET
  .../current` para cualquier staff, `GET .../:id` e historial para
  admin/cashier). No es "solo plata física": agrupa cualquier pedido que se
  confirma pagado (cash o QR) durante la sesión — el rango
  `opened_at..closed_at` ES el "día de negocio", necesario porque el turno
  real cruza medianoche. Un pedido normal se vincula recién cuando su pago
  se confirma de verdad (`cash/confirm`, o la decisión QR que lo marca
  `accepted`); uno fuera de horario se vincula al aceptarse (ver
  `late-order-requests`). Consecuencia: **confirmar cualquier pago exige
  caja abierta** — `409 cash_register_closed` si no la hay. El cierre
  calcula `expectedCashAmount`/`cashDifference` contra `countedCashAmount`
  y reporta `totalCashSalesAmount`/`totalQrSalesAmount`/`totalSalesAmount`
  (el bucket QR suma lo que el QR realmente cobró: el subtotal de un delivery
  `food_only`, el total con `food_and_delivery` — ver `QR_CHARGE_AMOUNT_SQL`),
  todo calculado y congelado en el momento del cierre (no se recalcula
  después). `GET .../current` agrega `liveTotals` con esas mismas sumas
  calculadas al vuelo sobre la sesión abierta, para que el POS muestre cómo
  va la caja durante el turno; los campos congelados de la raíz siguen en
  `null` hasta cerrar.
- **Storage de objetos** — las fotos de producto van a un bucket S3 o
  S3-compatible (AWS S3, Cloudflare R2, MinIO — vía `endpoint`) cuando están
  `STORAGE_S3_BUCKET` y las credenciales; sin bucket usa disco local
  automáticamente (en un host efímero se pierde en cada deploy). Los nombres
  anteriores `PAYMENT_PROOFS_S3_*` se siguen aceptando si no están los nuevos.
  **No hay comprobantes por foto**: el único cobro con QR es la API del banco.
- **`baneco` / `bank-qr`** — QR real de Banco Económico. `BanecoClientService`
  (`src/baneco/`) es el cliente HTTP crudo (`encrypt`/`authenticate`/
  `generateQR`/`statusQR`/`cancelQR`, validado en certificación contra el
  manual del banco; token cacheado en memoria con reautenticación en 401).
  `QrPaymentsService` (`src/bank-qr/`) es la capa de dominio:
  `generateForOrder` es idempotente (reusa el intento vivo si ya existe) y
  crea un `payment_attempts` en `pending_review` igual que hoy con una foto
  recién asociada — la confirmación real (`resolveCharge`) llama
  `paymentAttempts.decide(..., 'accepted')`, reusando 100% el CAS, el
  vínculo a caja y la notificación al cliente que ya existían. Como el banco
  no validó todavía `notifyPaymentQR` (su propio manual lo marca
  "pendiente"), el mecanismo principal es un cron (`QrPaymentsPollCron`,
  cada 5s) que usa `statusQR` — sí validado — sobre cada QR pendiente; el
  webhook `POST /api/qrsimple/notifyPaymentQR` (ruta, formato de request y
  respuesta `{responseCode, message}` calcados de la sección 6.5 del manual
  del banco) solo dispara esa misma re-verificación, nunca confía en el body
  (el manual no define auth para esa dirección — el Bearer es solo para
  comercio → banco). El `qrId` se acepta envuelto en `Payment`, en `payment`
  o plano en la raíz, porque el manual declara el objeto pero no da un JSON
  de ejemplo (ver `notify-payment.ts` y su spec).
  `POST /orders/:id/qr/generate` (JWT, `cashier`/`admin`) es la acción
  explícita del POS; el canal WhatsApp lo genera solo al crear el pedido
  (`orders.service.ts`). Si el banco falla no se rompe el pedido: el cliente
  recibe un aviso `qr_unavailable` (una sola vez) y `QrRetryCron` (cada 30 s,
  solo con el banco configurado) reintenta generar el QR hasta que el pedido
  venza por TTL; ahí lo cancela el cron de expiración y llega
  `order_expired_unpaid`. Un QR que se logra después sale como
  `qr_confirmation` normal.

  **Pago cobrado que no se puede aplicar**: `decide()` exige caja abierta,
  así que un pago que entra después del cierre no se puede aplicar. El orden
  importa y es deliberado: primero `decide()`, y recién si sale bien se marca
  el cobro `confirmed` — al revés, marcar `confirmed` primero haría que el
  cron dejara de mirar ese qrId (solo barre `pending`) y la plata quedaría
  cobrada en el banco con el pedido impago, sin reintento. Si falla por caja
  cerrada se anota `paid_detected_at` y se reintenta durante un margen de
  gracia de 20 min (cubre el cierre corto por cambio de turno, ver
  `unapplied-payment.ts`); pasado el margen el cobro queda `paid_unapplied`
  y se dispara una alerta a Telegram al staff. Aplicar ese pago a la caja del
  día siguiente sería peor que no aplicarlo: entraría en el cuadre de otra
  jornada y el pedido de anoche ya no se va a cocinar. La resolución es
  humana: `GET /bank-qr/unapplied-payments` (JWT, `cashier`/`admin`) lista la
  cola con teléfono del cliente para poder contactarlo, `POST
  /bank-qr/unapplied-payments/:id/apply` lo aplica si el local sigue abierto,
  y `POST /bank-qr/unapplied-payments/:id/refunded` (rol `admin`) deja
  registro de que ya se le devolvió la plata — el banco **no expone ninguna
  API de devolución** (manual v1.0.0: solo generar, anular, consultar y
  listar pagados), así que devolver es siempre manual y esto es solo la
  traza.
- **Servicios y canales habilitados** (`operational-settings`, PATCH solo
  `admin`; `GET /operational-settings` lo expone a los frontends). Servicios:
  `serviceDeliveryEnabled` / `servicePickupEnabled` / `serviceDineInEnabled`.
  Canales de origen: `channelPosEnabled` / `channelWhatsappEnabled` /
  `channelWebEnabled` / `channelExternalEnabled` (este arranca apagado, ver
  más abajo). El resto arranca prendido. Un pedido nuevo de un servicio
  apagado da `400 service_type_disabled`; de un canal apagado, `409
  channel_disabled` (el canal sale de la credencial, no del body). Se chequea
  antes del gate de horario, también en reemplazos, `switch-to-pickup`
  (exige pickup prendido) y `POST /delivery/quotes` (exige delivery). Solo
  afecta a pedidos **nuevos**: lo que ya existe sigue su ciclo, y una
  solicitud fuera de horario ya aceptada no se revalida. Reglas de
  consistencia (el PATCH rechaza el estado resultante sin escribir): al menos
  un servicio y un canal prendidos, y todo servicio prendido necesita al menos
  una forma de pago habilitada; a la inversa, un servicio apagado no exige
  forma de pago en `/payment-options`.
- **Canal `external`** (POS ajeno, para cocina y métricas): un local que
  vende en su propio POS puede reportar acá esas ventas. Se activa con
  `channelExternalEnabled` y un token de servicio llamado `external` en
  `SERVICE_AUTH_TOKENS`; el canal sale de la credencial. Un pedido `external`
  nace **ya cobrado** (`payment_status = paid`, por lo que entra a los
  reportes y la cocina lo puede preparar), no pasa por el horario ni por la
  caja, no se valida contra las formas de pago ni el mínimo, no manda avisos
  al cliente y **no admite delivery**. Los productos tienen que existir y
  estar disponibles en el catálogo. No se vincula a la caja, así que no
  entra al cierre de efectivo.
- **Caja opcional y política fuera de horario** (`operational-settings`,
  PATCH solo `admin`).
  - `outOfHoursPolicy` decide qué pasa con un pedido que llega **dentro del
    margen horario pero sin caja abierta**: `queue` (default; `202` +
    `late_order_requests` para aprobación humana), `reject` (`409 closed`) o
    `accept` (se toma directo; el cobro igual exige caja si es obligatoria).
    Fuera del margen ancho (`business_opens_hour`..`business_closes_hour`)
    siempre es `409 closed`, con cualquier política.
  - `requireOpenRegister: false` quita la caja del camino: cobrar no exige
    sesión abierta (el pago queda con `register_session_id = null` y entra a
    los reportes por fecha), el gate de horario no la consulta y no se encolan
    pedidos por caja cerrada. Si de todos modos hay una caja abierta, los
    pagos se vinculan a ella. La numeración (`ORD-0001`) pasa a un contador
    por **día de negocio** (`order_day_counters`; el turno que cruza
    medianoche cuenta como un solo día, ver `businessDayKey`). Abrir/cerrar
    caja sigue disponible como herramienta opcional de cuadre de efectivo.
- **Pago previo del efectivo** (`operational-settings`, PATCH solo `admin`):
  `cashPrepaymentRequired` (default `false`). Apagado, un pedido en efectivo
  puede pasar a `preparing` sin estar cobrado. Prendido, el efectivo de
  **pickup y mesa** también tiene que estar `paid` (confirmado por el cajero con
  `cash/confirm`) antes de cocinar, igual que QR y split; el de delivery no
  cambia. Un pedido en efectivo sin cobrar vence por el mismo TTL de pedidos sin
  pagar mientras cocina no lo haya aceptado.
- **Pedido mínimo y tarifa de envío** (`operational-settings`, PATCH solo
  `admin`).
  - Mínimo por servicio: `minOrderDelivery` / `minOrderPickup` /
    `minOrderDineIn` (0 = sin mínimo). Se compara contra el **subtotal**
    (la comida, sin envío). Por debajo: `400 below_minimum_order` con
    `details.minimumAmount`. También rige en reemplazos y al pedir fuera de
    horario; al aceptar una solicitud fuera de horario no se revalida.
  - Tarifa: `deliveryPricingMode` = `bands` (por distancia, tabla
    `delivery_tariff_bands`; es lo de siempre), `fixed` (`deliveryFixedFee`,
    obligatorio en ese modo) o `free`. Además `deliveryFreeOverAmount` (envío
    gratis si el subtotal lo alcanza; `null` lo apaga) y
    `deliveryMaxDistanceMeters` (techo de reparto; más allá el pedido queda
    `pending_manual` como siempre; `null` = el que dé la tarifa). Un envío
    gratis por política **exime también el recargo por lluvia**. Con
    `fixed`/`free` y sin techo no existe cotización manual
    (`409 manual_quote_not_applicable`). `POST /delivery/quotes` acepta
    `subtotalAmount` opcional para aplicar la gratuidad en una cotización
    suelta.
  - Cotización manual: `manualQuoteMaxAmount` (default 500) es el tope del
    monto que el staff puede fijar a mano en `POST /orders/:id/delivery/quote/
    manual` (token de servicio, o JWT `admin`/`cashier` desde el dashboard);
    por encima, `400 validation_error` con `details.maxAmount`.
- **`payment-options`** — qué formas de pago acepta el local, por tipo de
  servicio (`delivery` / `pickup` / `dine_in`). `GET /payment-options`
  (token de servicio o JWT) devuelve la lista para que los frontends pinten
  solo lo habilitado; `PATCH /payment-options` (JWT `admin`) prende o apaga
  filas y no deja un tipo de servicio sin ninguna forma de pago. Combinaciones:
  presencial → `cash` / `qr` / `split`; delivery → `cash` (contra entrega),
  `qr` + `qrScope: food_only` (el QR cobra la comida, el repartidor el
  envío) y `qr` + `qrScope: food_and_delivery` (el QR cobra todo; arranca
  apagada). Un método apagado da `400 payment_method_disabled` con las
  alternativas en `details.available`. El `qr_scope` elegido queda
  congelado en el pedido (y en `late_order_requests`), y de él salen el
  monto del QR (`qrChargeAmount`) y el aviso al grupo de delivery. Apagar una
  opción no afecta a un pedido fuera de horario ya aceptado por el local.

  **`available`**: cada fila de `GET /payment-options` trae, además de
  `enabled` (lo que prendió el admin), `available`: prendida **y** permitida
  para el canal de quien consulta **y** con el banco listo si hace falta. Los
  frontends pintan solo las `available`. Sin credenciales del banco, el QR y
  el split no están disponibles aunque estén prendidos: un pedido que los
  pida da `400 payment_method_disabled` con `details.reason =
  "bank_not_configured"`; el efectivo no depende del banco.

  **Canales por forma de pago**: cada fila lleva `channels` (`pos` /
  `whatsapp` / `web`, al menos uno): qué canales de origen pueden usarla. El
  canal sale de la credencial, nunca del body. Por defecto todo vale en todos
  los canales salvo `split`, que no se ofrece por WhatsApp (nadie presente para
  dividir el cobro). Prendida pero vedada para el canal del pedido da
  `400 payment_method_not_allowed` con las alternativas de ese canal en
  `details.available`. `PATCH /payment-options` acepta `enabled` y/o
  `channels` por fila (`channels` reemplaza la lista completa). Dividir el cobro
  (`POST /orders/:id/split-payment`) es siempre una acción del cajero y no mira
  el canal del pedido.

  **Regla del banco** (fija, sin toggle): `PATCH /payment-options` no deja
  *activar* una opción `qr`/`split` si faltan las credenciales `BANECO_*`
  (`409 bank_not_configured`, sin escribir nada). Solo mira las filas que pasan
  de apagadas a prendidas. Con `POS_QR_MODE=manual` el presencial queda exento
  (el cajero confirma a ojo); delivery no, porque ahí el cliente recibe el QR
  real. Un restaurante sin API del banco cobra solo en efectivo.
- **`auth`** — login JWT contra `dashboard_users` (bcrypt). Alta de staff
  vía API (`POST /auth/users`, `GET /auth/users`, `PATCH
  /auth/users/:id/active`), protegida con `@Roles('admin')` — el primer
  admin se crea con `npm run create-admin` (ver Setup arriba), ya que
  `POST /auth/users` exige estar logueado como admin.
- **`customers.findOrCreate`** — si `phone` y `email` llegan juntos y cada
  uno ya pertenece a un cliente distinto, se traduce a un 409
  (`customer_identity_conflict`) en vez de dejar escapar el unique
  violation crudo de Postgres.

## Qué falta / deuda conocida

- **Pago con QR bancario — pago real sin validar todavía**: Banco Económico
  solo confirmó `generateQR`/`statusQR`/`cancelQR` en certificación;
  `statusQrCode = 1` (pago real) y el webhook `notifyPaymentQR` siguen
  "pendiente" según su propio manual. El código está listo para ambos casos
  (polling ya funcional contra lo validado, webhook ya recibido pero
  tratado solo como señal de "revisá ya", nunca como fuente de verdad) —
  falta que el banco habilite una prueba de pago real en certificación para
  confirmar de punta a punta, y después pedir credenciales de producción
  (mismas env vars `BANECO_*`, sin cambios de código esperados).

  **URL del webhook para darle al banco**:
  `https://<tu-backend>/api/qrsimple/notifyPaymentQR`
- **`paidQR` sin usar**: la sección 6.6 del manual expone
  `GET /api/qrsimple/paidQR` con la lista de QR pagados de una fecha, pensada
  justamente para conciliación. Sería una red de seguridad mejor (y mucho más
  barata) que el cron de 5s: un barrido por día detecta cualquier pago que el
  webhook y el polling hayan perdido. Hoy no está implementado.
