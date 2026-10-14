# Levantar el backend para un restaurante nuevo

Esta plantilla no se edita por restaurante: cada uno es **una instancia
propia** (su base, su despliegue, sus credenciales) y se adapta por
configuración. Pasos, en orden.

## 1. Crear el repo y la base

1. Clonar/copiar la plantilla a un repo nuevo para ese restaurante.
2. Crear un Postgres propio (cualquier proveedor; el backend solo necesita la
   cadena de conexión `DATABASE_URL`, con credenciales propias).
3. `cp .env.example .env` y completar como mínimo: `DATABASE_URL`,
   `JWT_SECRET`, `SERVICE_AUTH_TOKENS`, `CORS_ORIGINS`, `APP_NAME`.
   Las integraciones (gateway de WhatsApp, Mapbox, S3/R2, banco) son
   opcionales: vacías, el módulo cae a su alternativa (línea recta, disco
   local, modo manual).

## 2. Esquema y datos del local

**Despliegue automático (sin acceso a la base ni a una terminal)** — Dokploy,
Railway u otro con Nixpacks. El `nixpacks.toml` del repo ya hace
`migrate:up` y arranca; el primer admin lo crea la app con dos variables:

```
BOOTSTRAP_ADMIN_USERNAME=admin          # opcional, "admin" por defecto
BOOTSTRAP_ADMIN_PASSWORD=<mínimo 8 caracteres>
```

Solo crea el admin si todavía no hay ninguno, así que dejarla puesta no
duplica ni pisa nada; igual conviene quitarla del entorno después del primer
arranque. Con ese admin se configura todo por API (sección 3): ubicación del
local con `PATCH /operational-settings` (`restaurantLatitude`,
`restaurantLongitude`) y bandas de delivery con `PUT /delivery/tariff-bands`.
Sin ubicación, delivery no puede cotizar.

**A mano (con terminal)**:

```bash
npm install
npm run migrate:up                 # aplica migrations/ (esquema, sin datos)
ADMIN_PASSWORD='...' npm run create-admin -- <usuario> admin
npm run start:dev
```

El seed `seeds/<restaurante>.sql` es opcional: solo es un atajo para cargar
ubicación y bandas por SQL si preferís no usar la API.

## 3. Reglas de negocio (por API, sin tocar código)

Todo se cambia en caliente con un usuario `admin` (JWT de `POST /auth/login`).
Los defaults reproducen el comportamiento original.

| Qué | Dónde | Campos |
|---|---|---|
| Formas de pago por servicio y canal | `PATCH /payment-options` | `serviceType` × `paymentMethod` × `qrScope`, `enabled`, `channels` (`pos`/`whatsapp`/`web`) |
| Servicios y canales que se toman | `PATCH /operational-settings` | `serviceDeliveryEnabled`, `servicePickupEnabled`, `serviceDineInEnabled`, `channelPosEnabled`, `channelWhatsappEnabled`, `channelWebEnabled` |
| Pedido mínimo | `PATCH /operational-settings` | `minOrderDelivery`, `minOrderPickup`, `minOrderDineIn` |
| Tarifa de envío | `PATCH /operational-settings` | `deliveryPricingMode` (`bands`/`fixed`/`free`), `deliveryFixedFee`, `deliveryFreeOverAmount`, `deliveryMaxDistanceMeters`, `manualQuoteMaxAmount` (tope de la cotización manual) |
| Recargo por lluvia | `PATCH /operational-settings` | `rainSurchargeEnabled`, `rainSurchargeAmount` |
| Horario (margen ancho) | `PATCH /operational-settings` | `businessOpensHour`, `businessClosesHour` |
| Caja obligatoria o no | `PATCH /operational-settings` | `requireOpenRegister` |
| Efectivo cobrado antes de cocinar (pickup/mesa) | `PATCH /operational-settings` | `cashPrepaymentRequired` |
| Canal de POS ajeno (ventas ya cobradas) | `PATCH /operational-settings` | `channelExternalEnabled` (+ token `external`) |
| Bandas de tarifa por distancia | `PUT /delivery/tariff-bands` | `bands[]` con `maxDistanceMeters` y `feeAmount` |
| Tope de cotización manual | `PATCH /operational-settings` | `manualQuoteMaxAmount` |
| Pedido fuera de horario | `PATCH /operational-settings` | `outOfHoursPolicy` (`queue`/`reject`/`accept`) |

El detalle y las reglas de consistencia de cada una están en el
[README](../README.md).

Otras reglas van por variable de entorno (se leen al arrancar):

| Qué | Variable | Default |
|---|---|---|
| Minutos antes de cancelar un pedido sin pagar | `UNPAID_ORDER_TTL_MINUTES` | 20 |
| Minutos que una solicitud fuera de horario espera al staff | `LATE_ORDER_REQUEST_TTL_MINUTES` | el de arriba |
| Destino del aviso a repartidores en el gateway | `DELIVERY_NOTICE_CHAT_REF` | `delivery-group` |
| Radio para que el repartidor acepte un pedido (m) | `DELIVERY_ACCEPT_RADIUS_METERS` | 150 |
| Bucket de fotos de producto (S3/R2); sin él, disco local | `STORAGE_S3_BUCKET` (+ `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_ENDPOINT`) | vacío |

Las bandas de tarifa por distancia se editan por API (`GET`/`PUT
/delivery/tariff-bands`, `admin`); el seed solo da un punto de partida.

El **gateway de mensajería es opcional**: con `GATEWAY_BASE_URL` o
`GATEWAY_AUTH_TOKEN` vacíos los avisos salientes (WhatsApp/Telegram) se
omiten, con una advertencia en el log, en vez de reintentarse y fallar.

## 4. Configuraciones típicas

**Local de mostrador, sin reparto, sin banco** (solo efectivo; el QR exige la
API del banco, no hay comprobantes por foto):

```jsonc
// PATCH /operational-settings
{ "serviceDeliveryEnabled": false, "requireOpenRegister": false }
// PATCH /payment-options
{ "options": [
  { "serviceType": "pickup",  "paymentMethod": "qr",    "enabled": false },
  { "serviceType": "pickup",  "paymentMethod": "split", "enabled": false },
  { "serviceType": "dine_in", "paymentMethod": "qr",    "enabled": false },
  { "serviceType": "dine_in", "paymentMethod": "split", "enabled": false }
] }
```

**Solo agente de WhatsApp + dashboard (sin POS)** — el personal usa el
dashboard para cocina, caja y reportes; los pedidos entran solo por el agente:

```jsonc
// PATCH /operational-settings
{ "channelPosEnabled": false, "serviceDineInEnabled": false,
  "requireOpenRegister": false, "outOfHoursPolicy": "accept" }
```

**POS ajeno + dashboard** — el local ya tiene su POS; acá solo cocina y
métricas. Su POS reporta cada venta con un token `external`
(`SERVICE_AUTH_TOKENS=external:<token>`):

```jsonc
// PATCH /operational-settings
{ "channelExternalEnabled": true, "channelPosEnabled": false,
  "requireOpenRegister": false }
// POST /orders  (Authorization: Bearer <token external>)
{ "customerName": "Mesa 4", "deliveryType": "dine_in", "paymentMethod": "cash",
  "items": [{ "productId": "<uuid>", "quantity": 2 }] }
```

El pedido nace cobrado: la cocina lo ve en `GET /orders` y entra a los
reportes.

**Delivery con envío fijo y gratis desde Bs 80:**

```jsonc
{ "deliveryPricingMode": "fixed", "deliveryFixedFee": 8, "deliveryFreeOverAmount": 80 }
```

**Delivery cobrado todo por QR** (comida + envío):

```jsonc
// PATCH /payment-options  (requiere credenciales BANECO_*)
{ "options": [
  { "serviceType": "delivery", "paymentMethod": "qr", "qrScope": "food_and_delivery", "enabled": true },
  { "serviceType": "delivery", "paymentMethod": "qr", "qrScope": "food_only", "enabled": false }
] }
```

## 5. Antes de salir a producción

- [ ] `JWT_SECRET` y tokens de `SERVICE_AUTH_TOKENS` generados al azar.
- [ ] `CORS_ORIGINS` con el origen real del POS/dashboard.
- [ ] Ubicación del local (`PATCH /operational-settings`) y bandas
      (`PUT /delivery/tariff-bands`) cargadas; probar `POST /delivery/quotes`.
- [ ] `BOOTSTRAP_ADMIN_PASSWORD` quitada del entorno después del primer arranque.
- [ ] Usuarios de staff creados (`POST /auth/users`): `cashier`, `kitchen`,
      `delivery`.
- [ ] Menú cargado (categorías, productos con foto, promociones).
- [ ] Si hay banco: URL del webhook entregada
      (`https://<backend>/api/qrsimple/notifyPaymentQR`).
- [ ] Revisar `GET /operational-settings` y `GET /payment-options`: lo que
      devuelven es lo que los frontends van a ofrecer.

## 6. Lo que sigue fijo a Bolivia

Hoy no es configurable (cambiarlo es código, no un toggle): zona horaria
`America/La_Paz` y fecha de negocio en Bolivia (`src/common/time`), moneda `BOB`
en los mensajes al cliente y el cliente del banco (Baneco). Los teléfonos no
asumen país. Para operar en otro país hay que parametrizar zona horaria y
moneda primero.
