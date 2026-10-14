# Integración del POS con el backend central

Este documento es para quien construya el front del POS. El backend ya
tiene toda la lógica de negocio (menú, pedidos, delivery, pagos) — el POS
es un cliente que solo llama a esta API, no reimplementa nada de eso.

**Alcance del POS**: `pickup` (para llevar desde el mostrador) y `dine_in`
(para comer en el local, mesa), sin delivery. Un pedido que no se cobra en 20 minutos se cancela solo. Pago en `cash` o `qr`
(no hay otros métodos). El QR es el de la API del banco (ver §QR real más
abajo); no hay comprobantes por foto.

## 0. Autenticación (un solo token en el POS: el JWT del cajero)

**El POS usa el JWT de sesión de staff para todo.** Se obtiene con
`POST /auth/login`, dura 8h (~un turno) y va en `Authorization: Bearer <jwt>`
en cada request. Guardalo en almacenamiento del dispositivo, nunca en la URL
ni en logs.

No hay un token de servicio embebido en la app. Existe un segundo mecanismo
de auth —un bearer estático por sistema, configurado en la env var
`SERVICE_AUTH_TOKENS` del backend— pero es para llamadas entre backends (el
gateway de WhatsApp). Un token así no vence, y cualquiera que abra las
devtools del navegador podría sacarlo del bundle y crear pedidos: por eso el
POS no lo usa.

En la práctica esto significa que **el POS no funciona sin alguien logueado**.
Si el cajero cierra sesión o el JWT vence, no se puede vender hasta el
siguiente login.

**Si cualquier request devuelve 401**, mandá al usuario de vuelta al login: el
backend usa el mismo mensaje para "token vencido" y "token inválido", así que
no se pueden distinguir. No hay refresh token. Podés decodificar el `exp` del
JWT para avisar antes de que se caiga a mitad de un turno.

Todas las requests son JSON (`Content-Type: application/json`), body en
`camelCase`.

**CORS**: el origen desde el que se sirve el POS tiene que estar en la env var
`CORS_ORIGINS` del backend, o el navegador falla en el preflight antes de
mandar nada.

⚠️ El backend valida con `forbidNonWhitelisted`: **cualquier campo de más en
el body devuelve 400**. No mandes el objeto de estado de React tal cual (con
su `tempId` o lo que sea) — serializá exactamente los campos del contrato.

## 1. Pantalla de login (staff)

```
POST /auth/login
{ "username": "...", "password": "..." }
→ 201 { "accessToken": "<jwt>", "user": { "id", "username", "role" } }
```

`role` es `admin` | `kitchen` | `cashier` — usalo para mostrar/ocultar
pantallas administrativas en el POS (por ejemplo, un `cashier` no debería
ver "gestionar menú"). El backend igual rechaza con 403 lo que el rol no
puede hacer, así que la UI es conveniencia, no seguridad.

## 2. Pantalla principal de venta — armar el catálogo

```
GET /categories
GET /products
GET /promotions
```

Cada producto trae `isActive` (existe en el menú) e `isAvailable`
(agotado hoy). `GET /products` ya filtra los inactivos, así que en la práctica
solo mirás `isAvailable`: mostralos marcados "agotado" en vez de ocultarlos,
para que el cajero entienda por qué no puede venderlos. Los precios vienen
como `number` (formatealos con dos decimales, el backend no lo hace).

⚠️ **`GET /promotions` no filtra nada** — devuelve archivadas, inactivas,
expiradas y programadas mezcladas, a diferencia de `/categories` y
`/products`. Filtrá por `status === 'activa'` en el cliente.

**Foto de producto**: cada producto trae `imageUrl` — `null` si no tiene
foto, o una ruta relativa (`/products/:id/image`) si tiene. No es una URL
directa al bucket: hay que pedirla con el mismo header `Authorization` que
usás para el resto de la API (el bearer del POS o la sesión del cajero,
cualquiera de los dos sirve). Como `<img src>` no manda headers, en el
navegador hacés `fetch` con el header y armás un `URL.createObjectURL(blob)`
para el `src`; cacheá ese blob en memoria por producto para no repetir el
fetch en cada render.

Las promociones traen `revision`: guardalo, se necesita al armar el pedido
(ver 4).

**Complementos** (`complements[]` en cada producto, ej. tomate/lechuga/
cebolla/pepinillo): en el detalle del producto dentro del carrito, mostralos
**todos tildados por defecto** — el cajero solo destilda lo que el cliente NO
quiere. No tienen precio propio, solo sirven para excluir ingredientes. Un
producto sin complementos configurados trae `complements: []` (nada que
mostrar).

`GET /categories?includeInactive=true` y `GET /products?includeInactive=true`
devuelven también las desactivadas/os — solo para la pantalla de
mantenimiento de menú (para poder reactivarlas), no para vender.

## 3. Cliente (opcional)

El POS puede vender sin cliente identificado ("cliente genérico" — no
mandes `customerId` al crear el pedido) o buscarlo/crearlo por teléfono si
quieren llevar historial:

```
POST /customers/find-or-create
{ "phone": "+59171234567", "name": "Juan Pérez" }   // ambos opcionales, pero al menos uno
→ 201 { "id": "<customerId>", ... }
```

Es un find-or-create literal: si el teléfono ya existe con otro nombre,
devuelve el registro existente **sin actualizar el nombre**. Y siempre
responde 201, tanto si creó como si encontró — no se puede distinguir.

## 4. Armar y confirmar la venta

```
POST /orders
Idempotency-Key: <uuid nuevo por cada intento de venta>
{
  "customerId": "<opcional>",
  "channel": "pos",                      // opcional: con JWT de staff el canal siempre es pos; si lo mandás con otro valor, 400 channel_mismatch
  "customerName": "Juan Pérez",           // obligatorio aunque no haya customerId — usá "Cliente mostrador" si no preguntan
  "deliveryType": "pickup",                // "pickup" = para llevar, "dine_in" = mesa; no hay delivery desde el POS
  "paymentMethod": "cash" | "qr",
  "bypassHoursGate": true,                 // el POS SIEMPRE puede vender fuera del horario de delivery de WhatsApp
  "notes": "sin cebolla",                  // opcional
  "items": [
    { "productId": "<uuid>", "quantity": 3 },
    { "productId": "<uuid>", "quantity": 1, "excludedComplements": ["cebolla"] }
  ],
  "promotions": [ { "promotionId": "<uuid>", "quantity": 1, "revision": 3 } ]  // revision = el que trajo GET /promotions
}
```

Límites del carrito: hasta 20 productos sueltos y 10 promociones, `quantity`
entre 1 y 10 por línea, y **sin `promotionId` repetidos**. Para `items`, lo
que no puede repetirse es la combinación exacta `productId` + selección de
complementos excluidos — dos líneas del mismo producto son válidas si tienen
distinta selección (ver abajo), pero repetir la misma combinación en dos
líneas da `400 validation_error` (sumá la cantidad en una sola línea en vez
de repetirla). Ojo: más de 10 unidades de la misma combinación no se puede
expresar en una sola línea.

**Complementos por línea** (`excludedComplements`, opcional): un producto
puede tener ingredientes que se pueden sacar (ver `complements[]` en el
catálogo, sección 2). Si el cliente pide "3 hamburguesas, 1 sin cebolla",
eso son **dos líneas del mismo `productId`**: una con `quantity: 3` sin el
campo, y otra con `quantity: 1` y `excludedComplements: ["cebolla"]` — no
se puede mezclar en una sola línea porque cada unidad podría llevar una
selección distinta. Mandar un nombre que el producto no tiene da
`400 unknown_complement`.

**`Idempotency-Key`**: generá un `uuid` v4 **al abrir el carrito**, no en el
clic de confirmar — si lo generás en el clic, un doble clic manda dos keys
distintas y cobra dos veces. Si la request falla por timeout de red y
reintentás, mandá **el mismo** uuid. Descartalo al completarse la venta o al
vaciar el carrito.

⚠️ **No reordenes `items[]` ni `promotions[]` entre reintentos.** La
comparación del body ignora el orden de las claves pero **no el de los
elementos del array**: reordenar con la misma key da un
`409 idempotency_key_reused` espurio. Lo más simple es serializar el body una
sola vez y reusar ese mismo string en el reintento.

Respuestas:
- **201** — venta nueva.
- **200** — respuesta cacheada de la misma key: es una **reimpresión de
  ticket, no un cobro nuevo**. Distinguir 200 de 201 importa.
- **202** — no debería pasar nunca con `bypassHoursGate: true`; si pasa, es
  un bug, avisen.
- **409 `product_unavailable`** / **`promotion_unavailable`** — algo del
  carrito se vendió/desactivó justo antes de confirmar. Mostrá el error y
  refrescá el catálogo (`details` trae qué producto/promo fue).

La respuesta trae el pedido completo — es lo que imprimís en el ticket:

- `items[]` — **solo los productos sueltos**, con los nombres y precios
  congelados al momento de la venta (`productNameSnapshot`,
  `unitPriceSnapshot`) y `excludedComplements[]` (imprimir en el ticket y
  mandar a cocina, ej. "SIN CEBOLLA").
- `promotions[]` — los combos, cada uno con `promotionNameSnapshot`,
  `promoPriceSnapshot`, `comboQuantity` y `componentsSnapshot[]` (qué
  productos entraron en el combo, para el ticket y para cocina).
- `subtotalAmount` / `totalAmount` — el total autoritativo.

⚠️ `Σ items[].subtotal` **no** cuadra con `subtotalAmount` cuando hay combos:
la diferencia está en `promotions[]`. No valides ese cuadre sumando solo
`items`.

Los totales que calculaste en pantalla son una estimación: el backend
recalcula precios y disponibilidad del lado servidor. Imprimí siempre el
`totalAmount` de la respuesta.

## 5. Apertura y cierre de caja

**Sin caja abierta no se puede cobrar nada** (ni efectivo ni QR) — es la
primera pantalla que necesita el POS antes de vender. Una sola caja abierta
a la vez para todo el local (no por cajero). Requiere rol `cashier` o
`admin`:

```
POST /cash-register/sessions/open
{ "openingAmount": 200 }             // efectivo con el que arranca el turno
→ 201 CashRegisterSession
```

Si ya hay una caja abierta, da `409 cash_register_already_open`. Antes de
mostrar el botón de "abrir caja", conviene chequear si ya hay una:

```
GET /cash-register/sessions/current   → CashRegisterSession & { liveTotals } | null
```

Cualquier rol logueado puede consultar esto (útil para saber si el POS ya
puede vender). Además de la sesión, trae `liveTotals` con cómo va el turno
**hasta este momento**, para mostrar el estado de la caja en pantalla sin
esperar al cierre:

```json
"liveTotals": {
  "totalCashSalesAmount": 840,
  "totalQrSalesAmount": 260,
  "totalSalesAmount": 1100,
  "expectedCashAmount": 1040
}
```

`expectedCashAmount` acá es `openingAmount` + lo cobrado en efectivo hasta
ahora: es lo que debería haber en el cajón si contaras en este instante. Ojo
que los campos del mismo nombre **en la raíz** de la sesión abierta siguen en
`null` — esos son los del arqueo firmado y solo se llenan al cerrar. Usá
`liveTotals` mientras el turno está abierto y los de la raíz una vez cerrado.

Al cerrar el turno:

```
POST /cash-register/sessions/close
{ "countedCashAmount": 950, "notes": "opcional" }   // lo que el cajero contó a mano
→ 200 CashRegisterSession (cerrada, con los totales ya calculados)
```

Si no hay ninguna abierta, da `409 cash_register_not_open`. La respuesta del
cierre trae, todo ya calculado por el backend (nunca lo calcules vos):

- `expectedCashAmount` — `openingAmount` + ventas en efectivo de la sesión.
- `cashDifference` — `countedCashAmount - expectedCashAmount` (negativo = faltó plata).
- `totalCashSalesAmount`, `totalQrSalesAmount`, `totalSalesAmount` — para el
  resumen del turno (efectivo, QR, y el total del día). Solo cuenta lo que
  **ya está pagado** (`paymentStatus: 'paid'`): un pedido tardío en efectivo
  queda vinculado a la caja al aceptarse (sección 8), pero no suma acá hasta
  que alguien haga `cash/confirm` — si se cierra la caja mientras sigue
  `unpaid`, ese pedido simplemente no entra en el total, no se pierde ni
  queda mal contado.

Estos números quedan **congelados en el momento del cierre** — no se
recalculan después aunque algo cambie más tarde. `GET /cash-register/sessions/:id`
(historial, `admin`/`cashier`) devuelve el mismo detalle de una sesión
cerrada, para reimprimir el reporte del cierre.

**Por qué esto bloquea el cobro**: cualquier pedido que se marca pagado (cash
o QR) queda vinculado a la caja abierta en ese instante — es lo que permite
calcular `totalCashSalesAmount`/`totalQrSalesAmount` al cerrar. Si intentás
cobrar sin caja abierta, el endpoint de cobro correspondiente (ver abajo) da
`409 cash_register_closed`: mostrale al cajero que tiene que abrir la caja
primero, no es un error del pedido.

## 6. Cobro

### Efectivo
```
POST /orders/:id/cash/confirm     → marca payment_status: 'paid'
POST /orders/:id/cash/cancel      → revierte si se equivocaron
```

Ambos son idempotentes: llamarlos dos veces es seguro, no cobran doble.
Devuelven el pedido completo actualizado. `cash/confirm` sin caja abierta da
`409 cash_register_closed` (ver sección 5). `cash/cancel` desvincula el
pedido de la caja (si el turno sigue abierto, ya no cuenta para el cierre).

### QR real (Banco Económico)

El cajero genera un QR real del banco para que el cliente lo escanee desde
su propia app bancaria — rol `cashier` o `admin`:

```
POST /orders/:id/qr/generate
→ { "orderId", "status": "pending", "qrImageUrl": "/orders/:id/qr-image", "dueDate" }
```

`qrImageUrl` es una ruta relativa (nunca el Base64 crudo ni una URL directa
del banco) — pedila con el mismo `Authorization: Bearer` de siempre, igual
que la foto de producto. Es **idempotente**: llamarlo dos veces para el
mismo pedido devuelve el mismo QR ya generado, no crea uno nuevo.

La confirmación del pago es **automática**: el backend consulta al banco
cada ~5s (`statusQR`) y en cuanto detecta el pago marca
`orders.payment_status: 'paid'` solo — no hace falta que el POS haga nada
más que esperar (polling de `GET /orders/:id` cada 3-5s mientras el QR está
en pantalla, para que la confirmación se sienta casi instantánea). Sin caja abierta, ni siquiera se puede
generar el QR — mismo `409 cash_register_closed` que el resto de los cobros.

**Fallback manual** — si la confirmación automática tarda o el banco está
caído, el cajero puede confirmar a ojo (vio la notificación de pago en su
propio celular, por ejemplo):

```
POST /orders/:id/payment-attempts/confirm-presencial
{ "decision": "accepted" | "rejected" }
```

El `:id` es el **id del pedido**, no el del intento de pago. Si ya había un
intento vivo (lo normal, dejado por `qr/generate`), decide sobre ese en vez
de crear uno nuevo. ⚠️ A diferencia de los endpoints de efectivo, este **no
devuelve el pedido** sino `{ attempt, won }` — pedí `GET /orders/:id`
después si necesitás el pedido actualizado para el ticket.

No hay pago con tarjeta — no es parte del alcance.

#### Modo manual (mientras el banco no habilite producción)

Con la variable de entorno `POS_QR_MODE=manual` en el backend, `POST
/orders/:id/qr/generate` responde `409 qr_manual_mode` para pedidos del POS
(el front **no debe llamarlo ni mostrar ningún QR generado por el
sistema**). El flujo pasa a ser 100% manual:

1. El cajero crea el pedido normal (`paymentMethod: "qr"`), igual que
   siempre.
2. En vez de un QR en pantalla, mostrale al cajero **un solo botón:
   "Confirmar pago"**.
3. El cajero muestra al cliente el QR de su propia cuenta bancaria (fuera
   del sistema), verifica en su banca que entró el monto exacto, y aprieta
   el botón — que llama al mismo `POST
   /orders/:id/payment-attempts/confirm-presencial` con
   `{"decision": "accepted"}` de arriba. No hace falta llamar
   `qr/generate` antes, funciona igual (crea el intento y lo decide en el
   mismo paso).

Esta variable es temporal: cuando el banco dé el ok de producción, se saca
del entorno de despliegue y el flujo vuelve a ser el QR real de arriba, sin tocar código.

### Pago dividido (parte efectivo, parte QR)

Para cuando el cliente paga una parte en efectivo y el resto por QR. El
cajero ingresa **los dos montos por separado** — el backend nunca calcula
uno a partir del otro, así un error de tipeo salta acá y no como una
diferencia de caja al cerrar la noche:

```
POST /orders/:id/split-payment
{ "cashAmount": 20, "qrAmount": 30 }   // tienen que sumar EXACTO totalAmount, o 400
→ 201 OrderResponse (paymentMethod pasa a "split")
```

Solo funciona mientras el pedido sigue `unpaid` — no se puede convertir a
split un pedido que ya tiene un pago en curso o confirmado por otro método
(`409 order_already_paid`).

Después de armar el split, confirmás cada pata con los endpoints que ya
conocés — no hay nada nuevo que aprender ahí:

- **Pata efectivo**: `POST /orders/:id/cash/confirm` / `cash/cancel`, igual
  que un pedido 100% efectivo.
- **Pata QR**: `POST /orders/:id/qr/generate` (QR real, cobra
  `qrAmount`, no `totalAmount`) o `POST
  /orders/:id/payment-attempts/confirm-presencial` (revisión manual) — igual
  que un pedido 100% QR.

`paymentStatus` recién pasa a `'paid'` cuando **las dos** patas están
confirmadas — no importa el orden en que las cobrés. Mientras falte una,
sigue `'unpaid'` (`GET /orders/:id` trae `splitCashAmount`, `splitQrAmount`
y `splitCashConfirmedAt` para que la pantalla muestre qué falta). Cancelar
la pata efectivo (`cash/cancel`) vuelve todo a `'unpaid'`, aunque la pata QR
ya estuviera aceptada — sin las dos, no está pagado. El cuadre de caja del
cierre (sección 5) ya reparte un split entre el total en efectivo y el
total en QR correctamente, no lo cuenta entero de un solo lado.

### Qué servicios y métodos mostrar

Antes de ofrecer "para llevar" o "mesa", mirá `GET /operational-settings`:
`servicePickupEnabled` y `serviceDineInEnabled`. Si el canal POS está apagado
(`channelPosEnabled: false`) `POST /orders` responde `409 channel_disabled`.

Antes de pintar las opciones de cobro, pedí `GET /payment-options` y mostrá solo
las filas con `available: true` para el tipo de servicio de la venta (`pickup` o
`dine_in`). `available` ya combina lo que prendió el admin (`enabled`), que el
canal POS pueda usarla (`channels`) y que el banco esté listo si hace falta
(sin credenciales del banco el QR y el split no están disponibles, salvo
`POS_QR_MODE=manual`). El local puede apagar efectivo, QR o split por separado.
Si igual mandás un método no disponible, el backend responde
`400 payment_method_disabled` (con `details.reason: "bank_not_configured"` si
fue por el banco) o `400 payment_method_not_allowed` (no permitido para el
canal), con las alternativas en `details.available`.

## 7. Tablero de pedidos (cocina)

**`GET /orders` requiere rol `kitchen`, `cashier` o `admin`.** La idea es
que cada persona se loguee en su pantalla, así queda registrado quién
movió cada pedido.

```
GET /orders?status=confirmed&limit=50&offset=0
```

Filtros: `customer_id`, `status`, `delivery_type`, `payment_status`
(todos **snake_case**, a diferencia del resto de la API), `limit`,
`offset`. Notas del listado:

- Devuelve un **array pelado**: no hay `total` ni `hasMore`. Para saber si hay
  más, pedí `limit + 1` y descartá el extra.
- `limit` se **recorta a 200 en silencio**, sin error.
- Un `status` inválido devuelve `[]` sin avisar — el backend no lo valida.
- Viene ordenado por `created_at desc`. Para cocina probablemente quieras el
  orden inverso (lo más viejo primero).
- No hay websockets: el tablero va por polling (5-10s es razonable).

Para mover un pedido de estado (ej. cocina marca "listo"):

```
PATCH /orders/:id/status
{ "to": "preparing" | "ready" | "out_for_delivery" | "delivered" | "cancelled" }
```

Transiciones válidas: `confirmed → preparing → ready → out_for_delivery →
delivered`, o `cancelled` desde casi cualquier punto. Un salto inválido
(ej. `confirmed → delivered` directo) da `409 invalid_state_transition`.
`delivered` y `cancelled` son terminales: no se sale de ahí, no hay deshacer.
La respuesta del pedido trae `statusUpdatedBy` con el username de quién
hizo el último cambio (solo el último, no hay historial).

⚠️ **No confundas dos errores distintos**: `invalid_state_transition` es un
error del usuario (salto ilegal), pero `409 status_conflict` significa que
otro operario movió el pedido entre que lo leíste y lo mandaste. Con varias
pantallas de cocina abiertas **va a pasar**: refrescá el pedido y mostrá el
estado actual, no un error rojo.

El backend bloquea `confirmed → preparing` con `409 payment_required` si
`paymentStatus` no es `paid` para QR y split (siempre). El efectivo queda
exento por defecto: cocina puede arrancar y se cobra al final. Si el local
prendió `cashPrepaymentRequired` (`GET /operational-settings`), el efectivo de
pickup y mesa también exige `paid` antes de cocinar (`cash/confirm`); el de
delivery nunca, porque lo cobra el repartidor. Las transiciones posteriores
(`preparing → ready → ...`) no vuelven a chequear el pago — si alguien
cancela el efectivo (`cash/cancel`) después de que ya empezó a prepararse,
el pedido sigue avanzando igual; marcalo visualmente si eso pasa.

**Delivery**: cocina lo lleva hasta `ready`. De ahí en adelante lo toma un
repartidor desde su propia pantalla (`docs/delivery-drivers-integration.md`):
`out_for_delivery` y `delivered` de un pedido de delivery solo los mueve el
repartidor (o un admin) — `PATCH /orders/:id/status` con rol `kitchen` da
`403 delivery_flow_only`. El envío que paga el cliente al repartidor se le
informa pero no se cuadra en el sistema.

`GET /orders/:id` (un solo pedido, no el listado) es para imprimir tickets o
consultar estado puntual, no para el tablero.

## 8. Pantallas administrativas

Todas necesitan el rol correcto:

| Pantalla | Endpoints | Rol |
|---|---|---|
| Mantenimiento de menú | `POST/PATCH /categories`, `/products`, `/promotions` | `admin` |
| Complementos de un producto | `complements: [{ "name": "..." }]` dentro del mismo `POST/PATCH /products` — mandarlo reemplaza la lista completa | `admin` |
| Foto de producto | `POST /products/:id/image` (ver abajo) | `admin` |
| Marcar producto agotado | `PATCH /products/:id/availability` | `admin` o `kitchen` |
| Configuración del local (horario, recargo lluvia, ubicación) | `GET/PATCH /operational-settings` | lectura: cualquiera; escritura: `admin` |
| Alta de staff | `POST/GET /auth/users`, `PATCH /auth/users/:id/active` | `admin` |
| Pedidos fuera de horario (cola) | `GET /late-order-requests`, `POST /:id/accept`, `POST /:id/reject` | `admin` o `cashier` |
| Apertura/cierre de caja | `POST /cash-register/sessions/open`, `/close` | `admin` o `cashier` |
| Pagos QR cobrados sin aplicar (ver abajo) | `GET /bank-qr/unapplied-payments`, `POST /:id/apply`, `POST /:id/refunded` | `admin` o `cashier` (`refunded`: solo `admin`) |

**Pagos QR cobrados sin aplicar.** Un cliente puede pagar el QR justo
después de que cerraron la caja. La plata entra al banco igual, pero el
backend no puede aplicarla a ningún turno, así que el cobro queda apartado y
llega una alerta a Telegram. Esta pantalla es la que resuelve esos casos:

```
GET /bank-qr/unapplied-payments
→ 200 [ { id, orderId, orderNumber, customerName, customerPhone, amount, paidDetectedAt, orderPaymentStatus } ]
```

Viene el teléfono del cliente justamente para poder escribirle. Dos salidas,
y las dos las decide una persona:

- `POST /bank-qr/unapplied-payments/:id/apply` → 204. El local sigue abierto:
  se aplica el pago al pedido y el pedido pasa a pagado. **Exige caja
  abierta** como cualquier cobro (si no hay, `409 cash_register_closed`).
- `POST /bank-qr/unapplied-payments/:id/refunded` → 204, body
  `{ "notes": "devuelto por transferencia" }` (opcional). Solo deja registro
  de que ya se le devolvió la plata al cliente: **el banco no tiene API de
  devolución**, así que devolver es siempre a mano y esto solo lo saca de la
  cola. El pedido no se toca — si hay que cancelarlo, va por
  `PATCH /orders/:id/status`.

Si el cobro ya no está pendiente de decisión (otro lo resolvió antes), las
dos devuelven `409 charge_not_unapplied`.

`POST /late-order-requests/:id/accept` exige caja abierta (sección 5) — es
el momento en que un pedido fuera de horario entra oficialmente al turno,
sea cash o QR. Sin caja abierta da `409 cash_register_closed` **sin tocar la
solicitud**: sigue `pending`, reintentá apenas alguien abra la caja. `reject`
no la necesita (no hay plata de por medio).

Trampas del mantenimiento de menú, todas por `forbidNonWhitelisted`:

- **`isAvailable` no se puede mandar a `PATCH /products/:id`** — da 400, no se
  ignora. La disponibilidad va solo por `PATCH /products/:id/availability`, y
  ahí el campo se llama **`available`**, no `isAvailable`. `code` tampoco es
  editable después de crear el producto.
- **Una promoción nace inactiva**: `POST /promotions` no acepta `isActive`, así
  que hace falta un segundo llamado a `PATCH /promotions/:id/active`. El orden
  se ajusta aparte con `POST /promotions/:id/move`.
- **`items` acepta desde 1 elemento**: una promoción puede ser un solo
  producto con precio especial (una unidad, o varias vía `quantity`). Lo que
  **sí** se rechaza es repetir el mismo `productId` en dos elementos del
  array — para "2 unidades" se usa `quantity: 2` en una sola línea, no dos
  líneas de `quantity: 1` (`400 promotion_duplicate_product`).

**Subir foto de producto**:

```
POST /products/:id/image
{ "mimeType": "image/jpeg" | "image/png" | "image/webp", "fileBase64": "<bytes en base64>" }
→ 200 ProductResponse (con imageUrl ya seteado)
```

Máximo 5 MB. Subir una foto nueva **reemplaza** la anterior (no hace falta
borrar antes). No hay endpoint para borrar la foto — para "sacarla" hoy
subís cualquier imagen en blanco; si hace falta un borrado real, pedilo y lo
agregamos.
- **`code` de producto duplicado** da `409 product_code_taken`.

## 9. Manejo de errores

Todo error de negocio tiene esta forma, siempre:

```json
{ "code": "product_unavailable", "message": "...", "details": { "...": "..." } }
```

Usá `code` para decidir el comportamiento de la UI (qué pantalla mostrar,
si hay que refrescar el catálogo, etc.); `message` es legible pero no está
pensado como el texto final para el cajero — armá sus propios mensajes por
`code`.

Hay dos formas más que no siguen ese molde y conviene normalizar en el cliente
de API antes de que la UI las vea:

- **Errores de validación**: `{ "code": "http_error", "message": [...] }` —
  ahí `message` es un **array de strings**, no un string.
- **Errores no previstos**: `{ "code": "internal_error", ... }` con 500.

Códigos que el POS puede encontrarse:

| `code` | HTTP | Qué hacer |
|---|---|---|
| `product_unavailable` / `promotion_unavailable` | 409 | Marcar el ítem y refrescar el catálogo; `details` dice cuál |
| `idempotency_in_progress` | 409 | **Transitorio**: reintentar con backoff, no mostrarlo como error |
| `idempotency_key_reused` | 409 | Bug del cliente: misma key con distinto body |
| `status_conflict` | 409 | Carrera entre pantallas: refrescar y reintentar |
| `invalid_state_transition` | 409 | Salto de estado ilegal |
| `payment_required` | 409 | Falta confirmar el pago antes de `preparing` (QR/split siempre; efectivo solo de pickup/mesa con `cashPrepaymentRequired`; nunca delivery+cash, es COD) |
| `payment_attempt_already_live` | 409 | Ya hay un intento de pago vivo para ese pedido |
| `cash_register_closed` | 409 | No hay caja abierta — mandá a abrir caja, no es error del pedido |
| `cash_register_already_open` | 409 | Ya hay una caja abierta (al intentar abrir otra) |
| `cash_register_not_open` | 409 | No hay caja abierta para cerrar |
| `closed` | 409 | No debería pasar con `bypassHoursGate: true` |
| `invalid_credentials` | 401 | Login fallido |
| `not_found` | 404 | `details.resource` dice qué no se encontró |
| `product_code_taken` / `username_taken` | 409 | Duplicado en alta de producto/staff |
| `promotion_duplicate_product` | 400 | El mismo `productId` aparece dos veces en `items` de una promoción — usá `quantity` |
| `unknown_complement` | 400 | `excludedComplements` trae un nombre que el producto no tiene; `details` dice cuál |
| `qr_manual_mode` | 409 | `POS_QR_MODE=manual` está activo — no llames `qr/generate`, usá `confirm-presencial` directo |
| `validation_error` / `http_error` | 400 | Error de formulario |

## 10. Para probar mientras desarrollan

- **Swagger UI** en `/docs` y el OpenAPI crudo en `/docs-json`, generados
  desde el código. Podés generar los tipos de request del cliente con
  `openapi-typescript` contra `/docs-json` en vez de escribirlos a mano.
  (Los tipos de *response* todavía no salen en el OpenAPI — ver README.)
- **Colección de Postman** en `postman/backend-central.postman_collection.json`,
  con todos los endpoints y ejemplos armados. Ojo: fue escrita cuando el POS
  usaba el token de servicio, así que para los endpoints de venta hay que
  reemplazarlo por un JWT de `POST /auth/login`.
