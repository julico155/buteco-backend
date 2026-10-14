# Plantilla de backend para restaurantes — guía para el POS / dashboard

Documento para quien construye la **plantilla del POS** (frontend). El backend
dejó de ser "el backend de un restaurante" y pasó a ser una **plantilla**: cada
restaurante despliega su propia instancia y adapta sus reglas **por
configuración, sin tocar código**. Esta guía dice qué lee el frontend, qué
reglas cambian lo que tiene que mostrar y qué errores tiene que manejar.

> Detalle de cada endpoint: [pos-integration.md](pos-integration.md),
> [pos-frontend-handoff.md](pos-frontend-handoff.md),
> [reports-integration.md](reports-integration.md),
> [delivery-drivers-integration.md](delivery-drivers-integration.md). Alta de un
> restaurante: [NUEVO-RESTAURANTE.md](NUEVO-RESTAURANTE.md). El contrato exacto de
> tipos sale de `/docs-json` (OpenAPI).

## 1. La idea

El frontend **no asume reglas**: las lee al iniciar sesión y pinta solo lo que
el local habilitó.

| Endpoint | Para qué | Quién |
|---|---|---|
| `GET /operational-settings` | Servicios, canales, mínimos, tarifa, caja, horario | servicio o cualquier JWT |
| `GET /payment-options` | Formas de pago, con `available` por canal y banco | servicio o cualquier JWT |
| `GET /products`, `GET /categories`, `GET /promotions` | Catálogo | servicio o cualquier JWT |

Todo se cambia en caliente con `PATCH`/`PUT` (rol `admin`). Un POS de venta
normalmente solo **lee**; la pantalla de administración es la que escribe.

### Tres formas de usar la plantilla

| Perfil | Quién vende | Qué hace el frontend |
|---|---|---|
| **A. POS completo** | El cajero en el POS (y opcionalmente el agente) | Venta, cobro, cocina, caja, reportes |
| **B. Agente + dashboard** | Solo el agente de WhatsApp | Sin pantalla de venta: cocina, caja/pagos, aprobaciones, reportes |
| **C. POS ajeno + dashboard** | El POS propio del local | Sin pantalla de venta: cocina y métricas de lo que ese POS reporta |

Cómo configurar cada uno: [NUEVO-RESTAURANTE.md §4](NUEVO-RESTAURANTE.md). El
mismo frontend sirve a los tres: la pantalla de venta se muestra solo si
`channelPosEnabled` es `true`.

## 2. Qué pantallas tiene sentido construir

| Pantalla | Roles | Endpoints principales |
|---|---|---|
| Venta (POS) | `cashier`, `admin` | `POST /orders`, `GET /payment-options`, `cash/confirm`, `qr/generate`, `split-payment` |
| Tablero de cocina | `kitchen`, `admin` (ve también `cashier`) | `GET /orders`, `PATCH /orders/:id/status` |
| Caja (turno) | `cashier`, `admin` | `/cash-register/sessions/*` |
| Pedidos fuera de horario | `cashier`, `admin` | `GET /late-order-requests`, `accept` / `reject` |
| Cotización manual de delivery | `cashier`, `admin` | `POST /orders/:id/delivery/quote/manual` |
| Pagos QR cobrados sin aplicar | `cashier`, `admin` (`refunded`: `admin`) | `/bank-qr/unapplied-payments*` |
| Repartidor | `delivery` | `/delivery/orders/*` |
| KPIs y gráficos | `admin`, `cashier`, `kitchen` | `GET /reports/kpis`, `sales/timeseries`, `products/top` |
| Ventas (lista y detalle) | `admin`, `cashier` | `GET /reports/sales/orders`, `…/:id` |
| Cierres de caja | `admin` | `GET /reports/cash-sessions` |
| Menú y promociones | `admin` (disponibilidad también `kitchen`) | `/products`, `/categories`, `/promotions` |
| Configuración del local | `admin` | `PATCH /operational-settings`, `PATCH /payment-options`, `PUT /delivery/tariff-bands` |
| Usuarios | `admin` | `/auth/users` |

El frontend tiene que ocultar lo que el rol no puede usar; el backend igual
responde `403`.

## 3. Configuración que el frontend lee

### 3.1 `GET /operational-settings`

| Campo | Tipo | Qué significa | Qué hace el frontend |
|---|---|---|---|
| `serviceDeliveryEnabled` / `servicePickupEnabled` / `serviceDineInEnabled` | boolean | Tipos de servicio que el local toma | Mostrar solo los prendidos |
| `channelPosEnabled` | boolean | Si el POS puede crear pedidos | `false` → ocultar la pantalla de venta (perfiles B y C) |
| `channelWhatsappEnabled` / `channelWebEnabled` | boolean | Otros canales | Informativo |
| `channelExternalEnabled` | boolean | Canal del POS ajeno (perfil C) | Informativo |
| `minOrderDelivery` / `minOrderPickup` / `minOrderDineIn` | number | Pedido mínimo sobre el **subtotal** (sin envío). `0` = sin mínimo | Avisar antes de cobrar; el backend igual responde `400 below_minimum_order` |
| `deliveryPricingMode` | `bands` \| `fixed` \| `free` | Cómo se cobra el envío (ver §6) | Informativo |
| `deliveryFixedFee` | number \| null | Monto en modo `fixed` | Informativo |
| `deliveryFreeOverAmount` | number \| null | Envío gratis desde este subtotal | Mostrar "envío gratis desde X" |
| `deliveryMaxDistanceMeters` | number \| null | Techo de reparto; más allá se cotiza a mano | Informativo |
| `manualQuoteMaxAmount` | number | Tope del monto de una cotización manual | Validar el input de cotización manual |
| `rainSurchargeEnabled` / `rainSurchargeAmount` | boolean / number | Recargo por lluvia (se suma al envío) | Mostrarlo en el desglose |
| `requireOpenRegister` | boolean | `true`: cobrar exige caja abierta. `false`: la caja es opcional | Ver §4.1 |
| `outOfHoursPolicy` | `queue` \| `reject` \| `accept` | Qué pasa con un pedido sin caja dentro del margen horario | Ver §4.2 |
| `cashPrepaymentRequired` | boolean | El efectivo de pickup/mesa se cobra **antes** de cocinar | Ver §4.3 |
| `businessOpensHour` / `businessClosesHour` | number | Margen **ancho** de cordura, no el horario exacto | No usarlo para decidir "abierto/cerrado" |

### 3.2 `GET /payment-options`

Una fila por combinación posible:

```jsonc
{ "serviceType": "pickup",   // delivery | pickup | dine_in
  "paymentMethod": "split",  // qr | cash | split
  "qrScope": null,           // solo delivery+qr: food_only | food_and_delivery
  "enabled": true,           // lo que prendió el admin
  "channels": ["pos", "web"],// canales que pueden usarla
  "available": true          // lo que hay que ofrecer
}
```

**Pintar solo las filas con `available: true`** para el `serviceType` de la
venta. `available` ya combina tres cosas, calculadas para el canal de la
credencial que consulta:

1. el admin la prendió (`enabled`);
2. ese canal puede usarla (`channels`);
3. el banco está listo si hace falta: **sin credenciales del banco, QR y split
   no están disponibles aunque estén prendidos** (el efectivo nunca depende del
   banco). Excepción: con `POS_QR_MODE=manual`, el QR presencial del POS queda
   disponible y el cajero lo confirma a ojo.

En delivery con QR puede haber dos variantes habilitadas (`food_only`: el QR
cobra la comida y el repartidor el envío; `food_and_delivery`: el QR cobra
todo). Si hay dos `available`, dejar elegir y mandar `qrScope` en `POST /orders`.

## 4. Reglas de negocio que cambian lo que se muestra

### 4.1 Caja opcional (`requireOpenRegister`)

- `true` (default): confirmar un pago exige una caja abierta
  (`409 cash_register_closed`).
- `false`: se puede cobrar sin caja. El pago queda sin sesión
  (`register_session_id = null`) y entra a los reportes por fecha. Si de todos
  modos hay una caja abierta, el pago se vincula a ella.
- La numeración (`ORD-0001`) pasa a contador por **día de negocio** (el turno
  que cruza medianoche cuenta como un solo día).
- Abrir/cerrar caja sigue existiendo como herramienta de cuadre. **No bloquear
  la venta** pidiendo "abrí la caja" cuando `requireOpenRegister` es `false`.

### 4.2 Pedido fuera de horario (`outOfHoursPolicy`)

Aplica a un pedido que llega **dentro del margen horario pero sin caja abierta**:

| Política | Respuesta de `POST /orders` | Qué hace el frontend |
|---|---|---|
| `queue` (default) | `202` + `late_order_request` | "Pendiente de aprobación"; el staff acepta o rechaza |
| `reject` | `409 closed` | "Local cerrado" |
| `accept` | `201`, se toma directo (el cobro igual exige caja si es obligatoria) | Flujo normal |

Fuera del margen ancho siempre es `409 closed`. El POS conserva su
`bypassHoursGate` (solo canal `pos`) para vender fuera de horario.

### 4.3 Pago previo del efectivo (`cashPrepaymentRequired`)

El backend bloquea `confirmed → preparing` con `409 payment_required` si el
pedido no está `paid`:

| Método | Regla |
|---|---|
| `qr`, `split` | Siempre exigen pago previo |
| `cash` | Exento por defecto (se cobra al final) |
| `cash` + `cashPrepaymentRequired = true` | Exige `paid` en **pickup y mesa**; en **delivery** sigue exento (lo cobra el repartidor) |

Con el flag prendido, llevar al cajero a `cash/confirm` antes de mandar a cocina.

### 4.4 Pago dividido

`POST /orders/:id/split-payment` (JWT `cashier`/`admin`) es solo presencial y
no mira el canal del pedido. Mostrarlo solo si hay una fila `split` con
`available: true` para ese servicio.

### 4.5 Cantidades

Máximo **30 unidades por línea** de producto y **30 por combo** (antes 10).
Más allá es `400 validation_error`. El carrito no puede repetir el mismo
producto con la misma selección de complementos: sumar la cantidad.

### 4.6 Cuando el banco falla al generar un QR

No hay comprobantes por foto: el único cobro con QR es la API del banco. Si
falla al crear el pedido, el backend no rompe nada: avisa al cliente por el
agente (`qr_unavailable`) y **reintenta solo cada 30 s** hasta que el pedido
venza por TTL (20 min por defecto), momento en que lo cancela. Para el POS:
`POST /orders/:id/qr/generate` puede responder error del banco; mostrar el
mensaje y dejar reintentar o cobrar en efectivo.

## 5. Delivery: lo que el frontend sí y no hace

- **Los pedidos de delivery entran por el agente** (necesitan ubicación del
  cliente y cotización). La pantalla de venta del POS cubre `pickup` y `dine_in`.
- `POST /delivery/quotes` y `POST /orders/:id/delivery/quote` son **solo token
  de servicio** (el agente): el POS con JWT no los usa.
- Un pedido fuera del techo queda `deliveryQuoteStatus: "pending_manual"`: el
  staff lo ve en `GET /orders` y fija el monto con
  `POST /orders/:id/delivery/quote/manual` (`admin`/`cashier`, tope
  `manualQuoteMaxAmount`).
- Lo mueve a `out_for_delivery` / `delivered` solo el repartidor desde su
  pantalla (a menos de `DELIVERY_ACCEPT_RADIUS_METERS` del local); `admin`
  puede forzarlo.

## 6. Cómo se calcula el envío (el frontend no calcula nada)

1. **Distancia** local → cliente. Con `MAPBOX_ACCESS_TOKEN`: distancia de calle;
   sin token, o si Mapbox falla o tarda más de 4 s: línea recta. El origen queda
   guardado.
2. **Techo**: si la distancia supera el techo (la última banda, o
   `deliveryMaxDistanceMeters` si es menor) no hay tarifa automática: el pedido
   queda `pending_manual`.
3. **Tarifa**, según `deliveryPricingMode`:
   - `bands`: la primera banda (por `band_index`) cuyo `max_distance_meters`
     alcanza la distancia; se cobra su `fee_amount`.
   - `fixed`: `deliveryFixedFee`, a cualquier distancia.
   - `free`: sin costo.
4. **Gratis desde X**: si `deliveryFreeOverAmount` está definido y el subtotal
   lo alcanza (`>=`), el envío es 0 y también se exime el recargo por lluvia.
5. **Recargo por lluvia**: si está prendido y el envío no es gratis, se suma.
6. **Total** = subtotal + envío + recargo, congelado en la misma transacción
   en que se cotiza.

Ejemplo con bandas `1 km→5`, `2 km→7`, `3 km→9`, `5 km→12`, `8 km→16`: a 4,2 km
cae en la banda de 5 km → envío 12. A 8,1 km supera la última → `pending_manual`.

**Bandas desde el dashboard** (pantalla de administración, `admin`):

```
GET /delivery/tariff-bands
PUT /delivery/tariff-bands   { "bands": [ { "maxDistanceMeters": 1000, "feeAmount": 5 }, … ] }
```

`PUT` reemplaza la tabla completa en una transacción. `band_index` sale de la
posición. Las distancias tienen que ser enteras y **estrictamente crecientes**
(si no, `400 validation_error` con `details.band`); hasta 50 bandas.

## 7. Canal `external` (perfil C: POS ajeno)

Para un local que vende en su propio POS y quiere cocina y métricas acá.

- Se activa con `channelExternalEnabled: true` y un token de servicio llamado
  `external` en `SERVICE_AUTH_TOKENS`. El canal sale de la credencial.
- Su POS reporta cada venta con `POST /orders` (token `external`). El pedido
  **nace cobrado** (`paymentStatus: "paid"`): la cocina lo ve en `GET /orders` y
  entra a los reportes ("vendido" = pagado y no cancelado).
- No pasa por el horario ni por la caja, no se valida contra las formas de
  pago ni el pedido mínimo, y no manda avisos al cliente.
- **No admite delivery** (`400 validation_error`).
- Los productos tienen que existir y estar disponibles en el catálogo de esta
  instancia: hay que cargarlos (o sincronizarlos) acá.
- No se vincula a la caja: no entra al cierre de efectivo.
- Si el POS ajeno anula una venta, hay que cancelarla acá
  (`PATCH /orders/:id/status` → `cancelled`, rol `kitchen`/`admin`) para que los
  reportes cuadren.

## 8. Errores que el frontend tiene que manejar

Todos vienen como `{ code, message, details }`. Mostrar un mensaje por `code`,
no el texto crudo.

| Código | HTTP | Cuándo | Qué mostrar |
|---|---|---|---|
| `service_type_disabled` | 400 | El servicio está apagado | "Este local no toma pedidos de {servicio}" |
| `channel_disabled` | 409 | El canal está apagado | "Este canal está deshabilitado" |
| `payment_method_disabled` | 400 | Forma de pago apagada, o QR/split sin banco (`details.reason = "bank_not_configured"`). `details.available` trae las alternativas | Ofrecer las de `available` |
| `payment_method_not_allowed` | 400 | Habilitada, pero no para este canal | Ofrecer las de `details.available` |
| `below_minimum_order` | 400 | Subtotal bajo el mínimo. `details.minimumAmount` | "Pedido mínimo: Bs X" |
| `closed` | 409 | Fuera del margen horario, o política `reject` | "Local cerrado" |
| `cash_register_closed` | 409 | Cobro sin caja abierta, con caja obligatoria | Llevar a abrir caja |
| `payment_required` | 409 | Pasar a cocina sin pago previo (§4.3) | "Cobrá antes de mandar a cocina" |
| `manual_quote_not_applicable` | 409 | Cotización manual donde no hay techo | No mostrar la acción |
| `validation_error` + `details.maxAmount` | 400 | Monto manual sobre el tope | "Máximo Bs X" |
| `validation_error` + `details.band` | 400 | Bandas de tarifa inválidas | Marcar la banda |
| `bank_not_configured` | 409 | El admin activa QR sin credenciales del banco | Solo administración |
| `qr_manual_mode` | 409 | `POS_QR_MODE=manual`: el POS no genera QR | Confirmar a ojo con `confirm-presencial` |
| `delivery_flow_only` | 403 | Cocina intenta mover un delivery a `out_for_delivery`/`delivered` | Ocultar la acción |

## 9. Qué sigue fijo (no es configurable)

- **País**: zona horaria `America/La_Paz` y moneda `BOB`. Otro país necesita
  cambios de código.
- **Banco**: QR con Banco Económico (Baneco). Otro banco requiere otro cliente.
  Sin credenciales, el local cobra solo en efectivo.
- **Idioma**: textos del backend en español.
- **Catálogo cerrado**: 3 servicios (`delivery`, `pickup`, `dine_in`), 3 métodos
  (`qr`, `cash`, `split`) y 4 canales (`pos`, `whatsapp`, `web`, `external`).
- **Estados del pedido** y **roles** (`admin`, `cashier`, `kitchen`, `delivery`).
- **Avisos**: con el gateway de mensajería sin configurar, los avisos
  salientes se omiten (no es un error).

## 10. Checklist para la plantilla del POS

**Siempre**
- [ ] Al iniciar sesión, pedir `GET /operational-settings` y `GET /payment-options`;
      refrescar al volver a la pestaña o cada pocos minutos.
- [ ] Mostrar solo los tipos de servicio prendidos.
- [ ] Armar los botones de cobro con `available: true`, sin listas fijas.
- [ ] Mapear los códigos de §8 a mensajes.
- [ ] Ocultar acciones según el rol (§2).
- [ ] Generar los tipos de request desde `/docs-json` con `openapi-typescript`.

**Pantalla de venta (perfil A)**
- [ ] Mostrarla solo si `channelPosEnabled`.
- [ ] No bloquear por "caja cerrada" si `requireOpenRegister` es `false`.
- [ ] Manejar `202 late_order_request` y `409 closed` según `outOfHoursPolicy`.
- [ ] Con `cashPrepaymentRequired`, forzar `cash/confirm` antes de cocina en
      pickup/mesa.
- [ ] Tope de 30 unidades por línea; mostrar pedido mínimo y "envío gratis desde X".

**Dashboard (perfiles B y C)**
- [ ] Tablero de cocina con polling (sin websockets) y los `pending_manual`
      resaltados.
- [ ] KPIs y serie de ventas para `admin`, `cashier` y `kitchen`.
- [ ] Pantalla de aprobación de pedidos fuera de horario (solo si la política es
      `queue`) y de pagos QR sin aplicar.
- [ ] Pantalla del repartidor si el local usa delivery.
- [ ] Administración: settings, formas de pago por canal y bandas de tarifa.
