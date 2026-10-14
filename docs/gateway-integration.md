# Integración con el agente de WhatsApp

Este documento es para quien implemente el agente de WhatsApp (o su reemplazo). El backend central ya tiene toda la lógica de negocio
(pedidos, pagos, delivery, promociones) — el agente **no debe reimplementar
nada de eso**, solo:

1. Recibir mensajes de WhatsApp y traducirlos a llamadas HTTP hacia este
   backend (dirección **agente → backend**, sección 2).
2. Exponer 3 endpoints propios para que este backend le pida enviar
   mensajes salientes (dirección **backend → agente**, sección 3).

## 0. Autenticación

Dos bearer tokens completamente independientes, nunca en el mismo header:

- **Agente → backend**: `Authorization: Bearer <SERVICE_AUTH_TOKENS del api_client "whatsapp-gateway">`. Te lo pasamos aparte (no va en este doc ni en el repo).
- **Backend → agente**: el backend manda `Authorization: Bearer <GATEWAY_AUTH_TOKEN>` en cada llamada a tus endpoints. Debes validar ese valor exacto — también te lo pasamos aparte.

Todas las llamadas en ambas direcciones son JSON (`Content-Type: application/json`).

## 1. Base URL

`https://<url-del-backend>`

## 2. Lo que el agente llama hacia el backend

### 2.1 Resolver/crear cliente

```
POST /customers/find-or-create
{ "phone": "+59171234567", "name": "Juan Pérez" }
→ 200/201 { "id": "<customerId>", "name": "...", "phone": "...", "email": null }
```

Guarda ese `customerId` — lo necesitas para todo lo demás.

### 2.2 Consultar menú (para armar el catálogo que le muestras al cliente)

```
GET /categories
GET /products
GET /promotions
```

Cada producto trae `imageUrl` — `null` si no tiene foto, o una ruta relativa
(`/products/:id/image`) si tiene. Para mandarla por WhatsApp: pedila con
`GET <baseUrl><imageUrl>` con tu mismo bearer de servicio, y subí los bytes
que te devuelve a la Media API de WhatsApp (no es una URL pública que
puedas pasarle directo a Meta).

Cada producto también trae `complements[]` (ej. tomate, lechuga, cebolla,
pepinillo) — ingredientes que el cliente puede pedir sacar. Por defecto van
TODOS incluidos; si el cliente dice "sin cebolla", usalo en el `item`
correspondiente al armar el pedido (ver 2.3). Un producto sin complementos
configurados trae `complements: []` — no le preguntes nada al cliente en
ese caso.

### 2.3 Crear pedido

```
POST /orders
Idempotency-Key: <uuid único por intento — SIEMPRE, ver nota abajo>
{
  "customerId": "<customerId>",
  "channel": "whatsapp",             // opcional: el canal se deriva de tu token (whatsapp-gateway = whatsapp); si lo mandás y no coincide, 400 channel_mismatch
  "customerName": "Juan Pérez",
  "deliveryType": "delivery" | "pickup" | "dine_in",   // pickup = para llevar, dine_in = comer en el local
  "paymentMethod": "qr",                 // "qr" o "cash" (todo el pedido, comida + envío, contra entrega) — split da 400 payment_method_not_allowed (por defecto; es configurable por canal en `/payment-options`)
  "notes": "sin cebolla" ,           // opcional
  "items": [
    { "productId": "<uuid>", "quantity": 3 },
    { "productId": "<uuid>", "quantity": 1, "excludedComplements": ["cebolla"] }
  ],
  "promotions": [ { "promotionId": "<uuid>", "quantity": 1, "revision": 3 } ] // opcional; revision = el que te devolvió GET /promotions
}
```

**`excludedComplements`** (opcional, por línea): si el cliente pide "3
hamburguesas, uno sin cebolla", eso son **dos líneas del mismo
`productId`** — no se puede mezclar en una sola porque cada unidad puede
llevar una selección distinta. Mandar un nombre que el producto no tiene en
su `complements[]` (ver 2.2) da `400 unknown_complement`. Repetir la misma
combinación producto+exclusión en dos líneas da `400 validation_error` —
sumá la cantidad en una sola línea.

Respuestas posibles:
- **200/201** — pedido creado. `200` si repetiste la misma `Idempotency-Key` con el mismo cuerpo (no se duplicó, te devuelve el mismo pedido de antes).
- **202** — el pedido queda pendiente de que un humano lo acepte (`late_order_request`). Pasa cada vez que no hay staff con la caja abierta en ese momento — puede ser tarde en la noche, pero también temprano si todavía no abrieron, o si cerraron antes de lo habitual esa noche en particular (el horario real varía). Avísale al cliente que su pedido está "en revisión", nunca que está confirmado — vence solo a los 20 minutos si nadie lo revisa.
- **409 `closed`** — fuera de cualquier horario plausible del local (ej. de madrugada/mañana), no se puede pedir.
- **409 `product_unavailable`** / **`promotion_unavailable`** — algo del carrito ya no está disponible; el `details` trae qué producto/promo fue.

**Sobre `Idempotency-Key`**: generá un UUID nuevo por cada intento REAL del usuario de confirmar su pedido, y **reusá el mismo UUID** si estás reintentando la misma request por un timeout/error de red — así nunca se duplica el pedido. No generes uno nuevo en cada reintento automático.

### 2.4 Delivery: pedir y adjuntar ubicación

Al crear un pedido de delivery, apenas queda en `awaiting_location` el
backend manda **una sola** solicitud (`location_request`, sección 3.2) —
**no hace falta que el agente lo pida**. Central solo entrega los datos
(`reason` + `orderNumber`); el copy final (incluido el "recibimos tu
pedido") lo arma el agente — ver sección 3.2 para el texto canónico
esperado. Pickup y mesa sí reciben `order_received` (sección 3.1) porque no
esperan ubicación. Un reintento de creación con el mismo `Idempotency-Key`
no vuelve a mandar nada (solo pasa en la creación real).

```
POST /orders/:id/location-request     // reenvío manual, por si hace falta pedirla de nuevo
POST /orders/:id/location
{ "latitude": -16.5, "longitude": -68.15 }
```

Adjuntar la ubicación dispara la cotización automáticamente (distancia real
por calle, tarifa, recargo por lluvia si aplica). La respuesta trae el
pedido actualizado con `totalAmount` ya con el delivery incluido.

⚠️ **`totalAmount` NO siempre es lo que se cobra por QR.** Usá `context.qrAmount`.
Con `paymentMethod: "qr"` y `qrScope: "food_only"` (o sin `qrScope`), el QR
cobra solo la comida (`subtotalAmount`) — nunca hay pago contra entrega de la
comida, pero el envío sí sigue siendo cobro contra entrega: el repartidor lo
cobra en efectivo al llegar. Con `qrScope: "food_and_delivery"`, `qrAmount` es
el `totalAmount` y el repartidor no cobra nada. Cuando le confirmés
el total al cliente, decile los dos montos por separado y aclarale ese
punto — por ejemplo: *"Tu pedido de comida es Bs {subtotalAmount} (ya
pagado por QR) + Bs {deliveryBaseAmount + deliverySurchargeAmount} de envío,
que le pagás al repartidor al recibir."* Si le decís un solo número
(`totalAmount`) sin aclarar, va a esperar que el QR cubra todo y se va a
confundir cuando el repartidor le pida el envío en efectivo.

#### Ubicación por teléfono (sin conocer el `orderId`)

```
POST /internal/agent/locations/attach        // solo token whatsapp-gateway
{ "customerPhone": "59170001234", "latitude": -17.78, "longitude": -63.18,
  "sourceMessageId": "wamid..." }
→ 200 { "result": ..., ... }
```

Central resuelve cliente (teléfono normalizado a `+<dígitos>`, nunca asume
país) y pedido; el agente no consulta pedidos ni calcula delivery. Siempre
responde 200 con `result`:

| `result` | Cuándo | Extra |
|---|---|---|
| `attached` | 1 pedido delivery esperando ubicación (`awaiting_location`, dentro del TTL de 20 min): se guarda y se cotiza | `orderId`, `orderNumber`, `quote` |
| `already_attached` | el pedido que espera ubicación ya tiene esa misma ubicación (tolerancia ~5 m) | `orderId`, `orderNumber` |
| `location_conflict` | el pedido que espera ubicación está en `pending_manual` y llega una ubicación distinta: **no se modifica nada** | `orders[]` |
| `ambiguous_order` | 2 o más pedidos esperando ubicación: no elige ninguno | `orders[]` (`id`, `orderNumber`, `totalAmount`) |
| `no_order` | no hay cliente o ningún pedido esperando ubicación y vigente. Vencidos, cancelados y pedidos ya cotizados/en curso **no cuentan** (no se miran): es la señal para pasar a `POST /delivery/quotes` | — |

Una ubicación distinta con el pedido todavía sin cotizar (`pending`/`failed`)
reemplaza la anterior y cotiza (`attached`). `sourceMessageId` deduplica
reintentos: el mismo `wamid` con el mismo cuerpo devuelve la misma respuesta;
con otro cuerpo, `409 idempotency_key_reused`. `POST /orders/:id/location`
aplica la misma protección (`409 location_conflict`).

#### Cotizar sin pedido

```
POST /delivery/quotes        // Idempotency-Key obligatorio
{ "latitude": -17.78, "longitude": -63.18 }
→ { "status": "quoted", "distanceMeters": 4200, "feeAmount": 15,
    "surchargeAmount": 3, "totalAmount": 18 }
```

`totalAmount` = tarifa + recargo por lluvia vigente (el monto real). No crea
pedido ni guarda la ubicación para uno futuro: al crear el pedido hay que
pedir/adjuntar una ubicación nueva. `status: "manual_quote"` = fuera del
rango automático (montos `null`).

### 2.4b Servicios y canales apagados

El local puede apagar tipos de servicio (`delivery`, `pickup`, `dine_in`) y
canales. `POST /orders` (y reemplazos) responde `400 service_type_disabled`
con `details.available` si el `deliveryType` está apagado, o `409
channel_disabled` si el canal del token (`whatsapp-gateway` / `web`) está
apagado. `GET /operational-settings` trae los flags (`serviceDeliveryEnabled`,
`channelWhatsappEnabled`, ...) para no ofrecerle al cliente lo que se va a
rechazar.

### 2.4d Fuera de horario y caja

Con la caja cerrada dentro del margen horario, `POST /orders` puede devolver
`202` (solicitud en cola, política `queue`), `409 closed` (`reject`) o crear
el pedido normal (`accept`, o si el local no exige caja). Mirá
`outOfHoursPolicy` y `requireOpenRegister` en `GET /operational-settings`.

### 2.4c Pedido mínimo y envío gratis

`POST /orders` responde `400 below_minimum_order` (`details.minimumAmount`,
`details.subtotalAmount`) si el subtotal de la comida no llega al mínimo del
tipo de servicio; el envío no cuenta. `GET /operational-settings` trae
`minOrderDelivery`, `deliveryPricingMode`, `deliveryFreeOverAmount`, etc. En
`POST /delivery/quotes` podés mandar `subtotalAmount` para que la cotización
refleje "envío gratis desde X". El envío gratis por política no suma recargo por
lluvia.

### 2.5 Pago: QR o efectivo contra entrega

**Reglas de pago de WhatsApp**: `paymentMethod` es `"qr"` o `"cash"` —
`split` no tiene sentido por este canal (nadie presente para dividir
el cobro). Un pedido QR que no se paga en **20 minutos** se
cancela solo (se anula su QR en el banco y le llega al cliente un mensaje
saliente normal avisándole que el pedido fue cancelado y que puede hacer uno
nuevo) — un pedido `cash` no tiene ese TTL una vez que cocina lo acepta (ver
abajo). El token del agente ya **no** puede confirmar ni cancelar cobros en
efectivo (`cash/confirm` y `cash/cancel` son solo para staff; el que
confirma un `cash` de delivery es el repartidor, al entregar, con su propio
rol — no con este token).

**`paymentMethod: "qr"`** — el backend genera un QR real del banco y te manda
solo una intención `messageType: "qr_confirmation"` (ver sección 3.1 para el
`context` completo, con el desglose de productos, subtotal y envío) — no
hace falta que el agente pida nada. **El momento en que se manda depende del
tipo de pedido**: pickup y mesa no esperan nada más, así que el QR sale
apenas se crea el pedido. Delivery todavía no tiene el total final (falta el
envío, que se calcula recién con la ubicación) — el QR sale recién cuando el
pedido pasa de `awaiting_location` a `confirmed` con la cotización aplicada,
es decir tras `POST /internal/agent/locations/attach` (sección 2.3) con
resultado `attached` y cotización `applied`. Si la ubicación cae
`pending_manual` (fuera del techo automático), el QR espera a que un
`admin`/`cashier` fije el monto a mano; ahí también se manda solo. La
confirmación del pago es automática (el backend consulta al banco solo);
cuando se confirma, el agente recibe `messageType: "payment_confirmed"`
(sección 3.1). **Qué cobra el QR depende de `qrScope`** (solo delivery):
`"food_only"` (default) cobra solo la comida (`subtotalAmount`) y el envío
se paga en efectivo al repartidor; `"food_and_delivery"` cobra el total y el
repartidor no cobra nada. `GET /payment-options` dice cuáles están
habilitadas; si no mandás `qrScope`, el backend usa la única habilitada o
`food_only`. El `context` de `qr_confirmation` trae `qrAmount` (lo que
realmente cobra el QR) y `qrScope`. Un método apagado responde
`400 payment_method_disabled` con `details.available`.

**`paymentMethod: "cash"`** — todo el pedido (comida + envío) se cobra en
efectivo al entregar (o al retirar, si es pickup), no hay QR de por medio.
En vez de `qr_confirmation` te llega `messageType:
"cash_on_delivery_confirmation"` con el desglose completo (`subtotalAmount`,
`deliveryBaseAmount`, `deliverySurchargeAmount`, `deliveryAmount`,
`totalAmount`) ya definitivo (mismo momento que el QR: apenas se crea para
pickup/mesa, recién tras cotizar para delivery). Cocina puede empezar a preparar **sin que `payment_status` sea
`paid` todavía** — eso es intencional, el cobro pasa al entregar. Si el
cliente no paga al recibir, el pedido se entrega igual (el negocio se lo
cobra al repartidor después, fuera del sistema) — nunca se bloquea la
entrega por eso.

Si el banco falla al generar el QR, el backend **no** pide captura: manda
`messageType: "qr_unavailable"` (una sola vez) y sigue intentando solo cada
30 s. El agente solo avisa que el QR se demora y en cuántos minutos vence el
pedido (`context.expiresInMinutes`). Si el banco se recupera, llega el
`qr_confirmation` normal; si no, el pedido se cancela por TTL y llega
`order_expired_unpaid`. `context.qrAmount` es lo que cobrará el QR (solo la
comida, o comida + envío con `food_and_delivery`).

#### Fotos de comprobante

Ya **no existe** `POST /payment-proofs`: el único cobro con QR es el del
banco y se confirma solo. Si el cliente manda una foto de comprobante, el
agente no tiene dónde subirla; lo correcto es responderle que el pago se
confirma automáticamente y que, si ya pagó, en unos segundos recibirá la
confirmación.

### 2.6 Consultar estado de un pedido (opcional, para polling)

```
GET /orders/:id
```

### 2.7 Modificar mi pedido (replace-not-mutate)

Nunca se editan las líneas de un pedido existente: uno nuevo reemplaza al
viejo. Central resuelve todo por `customerPhone` — vos nunca decidís cuál es
el pedido activo, si está pagado, ni precios/promos/delivery: eso lo
revalida Central de nuevo en cada llamada, incluso si ya te lo dijo hace un
minuto (puede haber cambiado, por ejemplo si el banco confirmó el pago
mientras el cliente armaba el carrito nuevo).

**Resolver si hay algo para modificar:**
```
GET /internal/agent/orders/replaceable?customerPhone=+59170001234
→ 200 { "result": "no_order" }
  | { "result": "not_replaceable", "reasonCode": "already_paid" | "payment_status_not_unpaid" | "payment_in_progress" | "operational" }
  | { "result": "replaceable", "orderId", "orderNumber", "status", "deliveryType",
      "paymentMethod": "qr" | "cash" | "split",
      "hasLocation": true,
      "cart": { "deliveryType", "items": [{productId, quantity, excludedComplements}],
                "promotions": [{promotionId, quantity}] } }
```
`cart` trae solo identificadores y cantidades — nunca precios como
autoridad, son solo para precargar el menú. `not_replaceable` con
`already_paid`/`payment_in_progress`: hacé handoff humano y silencio
automático, no ofrezcas modificar. `no_order`: menú normal, no hay nada que
reemplazar.

**Agregar una preferencia simple ("sin cebolla") sin tocar el carrito:**
```
POST /internal/agent/orders/notes
Idempotency-Key: <sourceMessageId>
{ "customerPhone": "...", "note": "sin cebolla", "sourceMessageId": "wamid..." }
→ 200 { "result": "saved" | "no_order" | "not_allowed" }
```
Se acumula sobre `orders.notes` del último pedido activo (nunca un
`orderId` que vos elijas). `not_allowed` = hay un pedido activo pero ya no
es modificable (pagado, en curso) — no lo conviertas en nota, hacé handoff.
Central **no** manda ninguna confirmación automática al cliente por esto.

**Confirmar el carrito modificado:**
```
POST /internal/agent/orders/replacements
Idempotency-Key: <uuid nuevo por intento real>
{
  "customerPhone": "...",
  "orderId": "...",              // el que te dio replaceable
  "customerName": "Juan Pérez",
  "deliveryType": "delivery",
  "paymentMethod": "qr",         // whatsapp-gateway: solo qr (igual que 2.3). web: sin esa restricción.
  "notes": "sin cebolla",        // opcional — NUNCA se hereda del pedido viejo, es texto nuevo
  "items": [...], "promotions": [...]
}
→ 201 { "result": "replaced", "orderId": "<pedido nuevo>", "orderNumber": "<pedido nuevo>", "replacedOrderId": "<pedido viejo>" }
  | 404 { "code": "not_found", ... }                 // no hay cliente, o no tiene ningún pedido activo de TU canal
  | 409 { "code": "stale_order", "details": { "currentOrderId": "..." } }
  | 409 { "code": "not_replaceable", "details": { "reasonCode": "..." } }
```
`orderId` **nunca** se usa para buscar el pedido directamente — Central
resuelve el último pedido activo **del mismo canal con que te autenticaste**
(`whatsapp-gateway` → canal whatsapp; `web` → canal web) del cliente por su
cuenta (por `customerPhone`, igual que `replaceable`, e ignorando por
completo cualquier pedido de otro canal — POS, o el otro de estos dos) y
recién ahí compara contra lo que mandaste. Si no coinciden —tu `orderId`
quedó viejo, o apuntaba a otra cosa— da `stale_order` con el id correcto
(`currentOrderId`) para que vuelvas a consultar `GET replaceable`. Esto es
intencional: ni un `orderId` viejo ni uno de otro canal pueden disparar un
reemplazo. **Los 3 endpoints de esta sección (2.7) nunca cruzan canales**:
un pedido que empezó por WhatsApp no se puede continuar desde el checkout
web ni viceversa — si el cliente solo tiene un pedido activo en el otro
canal, acá da `no_order`/`not_found` como si no tuviera nada.
El pedido nuevo se crea con la misma lógica autoritativa que `POST /orders`
(revalida catálogo, precios, promos), con el mismo canal que lo creó, y
dispara los mismos avisos (`order_received`/`location_request`/QR — ver
2.4/2.5). **Solo para `whatsapp-gateway`**: si el pedido viejo era delivery y
el nuevo sigue siendo delivery, Central reusa la ubicación guardada (nunca
la tarifa: se recotiza entera) — no hace falta volver a pedir el pin. Para
`web` esto NO aplica — el pedido nuevo siempre queda esperando ubicación
propia (el checkout la vuelve a pedir y la adjunta con
`POST /orders/:id/location`), justamente para que esa llamada no choque con
`location_conflict` contra una ubicación que Central ya hubiera copiado y
cotizado de antes. Si cambia a `pickup`, o si no había ubicación previa,
sigue el flujo normal de `location_request`.

⚠️ **Riesgo conocido, por decisión de producto**: el QR bancario del pedido
viejo NO se cancela automáticamente — sigue siendo técnicamente cobrable
hasta que expire solo. Si alguien lo paga después de reemplazado, Central lo
detecta (el pedido viejo ya está `cancelled`, el pago nunca se le aplica) y
lo manda directo a la cola de "pagos sin aplicar" para que el staff lo
resuelva a mano — **nunca** revive el pedido viejo como pagado ni lo manda a
cocina/reparto. Garantizado por código (`PaymentAttemptsService` no aplica
pagos a un pedido `cancelled`) y cubierto por tests.

## 3. Lo que el agente debe exponer (el backend te llama a vos)

Estos 3 endpoints son responsabilidad del agente. El backend reintenta
automáticamente con backoff si fallan (hasta 8 intentos), así que
devolver un error HTTP ante un fallo real (en vez de colgarse) es correcto.

### 3.1 Enviar mensaje de WhatsApp

**Central nunca manda texto customer-facing.** Todo lo que llega por
`POST /gateway/whatsapp/messages` es una intención estructurada:
`{ customerId, messageType, context, imageUrl? }`. El agente decide copy,
emojis, formato y CTA — Central solo entrega los datos.

```
POST /gateway/whatsapp/messages
{ "customerId": "<uuid>", "messageType": "qr_confirmation",
  "imageUrl": "...", "context": { ... } }
→ 200 { "externalMessageId": "<id del mensaje que devuelve la API de WhatsApp>" }
```

`externalMessageId`: el backend lo guarda para trazabilidad del envío. Si tu
proveedor de WhatsApp no te da un id de mensaje, devolvé cualquier string
único y estable para ese envío.

`messageType` y su `context`:

| `messageType` | Cuándo | `context` |
|---|---|---|
| `order_received` | Pickup/mesa al crear el pedido (delivery no lo recibe, ver `location_request`) | `{ orderNumber, deliveryType }` |
| `qr_confirmation` | QR real generado con éxito (pickup/mesa al crear; delivery recién tras cotizar) | `{ orderNumber, currency: "BOB", deliveryType, items[], promotions[], subtotalAmount, deliveryBaseAmount, deliverySurchargeAmount, deliveryAmount, totalAmount, qrAmount }` + `imageUrl` |
| `qr_unavailable` | El banco no pudo generar el QR todavía: se reintenta solo; si no se logra antes del TTL, el pedido se cancela. Es un aviso, el cliente no tiene que hacer nada | `{ orderNumber, qrAmount, expiresInMinutes }` |
| `cash_on_delivery_confirmation` | `paymentMethod: "cash"`: desglose definitivo a cobrar contra entrega (comida + envío), mismo momento que `qr_confirmation` | `{ orderNumber, deliveryType, subtotalAmount, deliveryBaseAmount, deliverySurchargeAmount, deliveryAmount, totalAmount }` |
| `payment_confirmed` | Pago aceptado (QR o efectivo). `fullyPaid: false` solo en un `split` cuando la pata QR entró pero la pata efectivo todavía no | `{ orderNumber, deliveryType, fullyPaid }` |
| `payment_rejected` | El pago fue rechazado | `{ orderNumber, deliveryType }` |
| `order_expired_unpaid` | El pedido se cancela solo por no pagarse en el TTL (20 min) | `{ orderNumber }` |
| `late_request_unavailable` | Solicitud fuera de horario aceptada por staff, pero el carrito ya no está disponible (producto/promo caídos) | `{ requestNumber }` |
| `late_request_accepted` | Solicitud fuera de horario aceptada, pedido creado | `{ requestNumber, orderId }` |
| `late_request_rejected` | Solicitud fuera de horario rechazada por staff | `{ requestNumber }` |

**`qr_confirmation.context` en detalle** — Central calcula y entrega todos
los montos, el agente no recalcula nada:

```
{
  "orderNumber": "ORD-260929-007",
  "currency": "BOB",
  "deliveryType": "delivery",
  "items": [
    { "name": "Hamburguesa", "quantity": 1, "unitPrice": 18, "subtotal": 18, "excludedComplements": [] },
    { "name": "Limonada", "quantity": 1, "unitPrice": 4, "subtotal": 4, "excludedComplements": [] }
  ],
  "promotions": [
    { "name": "Combo Hamburguesa", "quantity": 1, "unitPrice": 20, "subtotal": 20,
      "components": [{ "name": "Hamburguesa", "quantity": 1 }, { "name": "Gaseosa", "quantity": 1 }] }
  ],
  "subtotalAmount": 22,
  "deliveryBaseAmount": 8,
  "deliverySurchargeAmount": 2,
  "deliveryAmount": 10,
  "totalAmount": 32,
  "qrAmount": 22
}
```

`qrAmount` es siempre `subtotalAmount` — **el monto autoritativo que cobra
ESTE QR**, nunca incluye envío. Para pickup/mesa, `deliveryAmount` es `0` y
`totalAmount === subtotalAmount === qrAmount` (no hay envío que cobrar
aparte). Para delivery, mostrale al cliente el desglose completo: el envío
se paga en efectivo al repartidor al momento de la entrega, nunca por QR —
si solo le mostrás `qrAmount`/`totalAmount` sin aclarar, va a esperar que
el QR cubra todo y se va a confundir cuando el repartidor le pida el envío.

### 3.2 Pedir ubicación al cliente

```
POST /gateway/whatsapp/location-requests
{ "customerId": "<uuid>", "reason": "delivery_location", "orderNumber": "ORD-260929-007" }
→ 204 (sin body)
```

`orderNumber` es nuevo y opcional (compatibilidad hacia atrás: una llamada
vieja sin `orderNumber` sigue siendo válida). Con `orderNumber`, armá el
mensaje canónico — mostrando el pedido corto (`ORD-AAMMDD-NNN` → `#N`; los
formatos legacy se muestran completos):

```
📦 Recibimos tu pedido #7.

📍 Ahora envíanos tu *UBICACIÓN ACTUAL* por GPS para calcular el costo del envío 😊
Pedido ORD-260929-007

Toca el clip 📎 → Ubicación → ENVIAR UBICACIÓN ACTUAL
```

Sin `orderNumber` (llamada legacy), el fallback:

```
Por favor comparte tu ubicación actual para coordinar el delivery.

Toca el clip 📎 → Ubicación → ENVIAR UBICACIÓN ACTUAL
```

### 3.3 Alerta a Telegram (grupo de staff)

```
POST /gateway/telegram/alerts
{
  "chatRef": "staff-group",
  "text": "Solicitud fuera de horario SOL-000045 — Juan Pérez, total 45.00.",
  "editMessageId": "<opcional — si viene, editá el mensaje existente en vez de mandar uno nuevo>",
  "buttons": [
    { "label": "Aceptar", "action": "late-order-requests/<id>/accept" },
    { "label": "Rechazar", "action": "late-order-requests/<id>/reject" }
  ]
}
→ 200 { "externalMessageId": "<id del mensaje de Telegram>" }
```

Los botones son solo texto/acción para que vos armes el teclado inline de
Telegram — el backend no sabe nada de la UI de Telegram, solo te pasa
label+action.

## 4. Errores

Todos los errores de este backend tienen esta forma (nunca texto crudo de
Postgres ni stack traces):

```json
{ "code": "product_unavailable", "message": "...", "details": { "...": "..." } }
```

Usá `code` para decidir programáticamente qué decirle al cliente; `message`
es para vos (debug), no está pensado para mostrárselo tal cual al usuario final.
