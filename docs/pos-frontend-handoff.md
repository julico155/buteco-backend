# Handoff: frontend del POS (para pegar como CLAUDE.md en el repo del front)

> Este archivo vive en el repo del backend solo como respaldo versionado.
> La copia que realmente importa es la que pegues en la raíz del repo del
> front como `CLAUDE.md` — Claude Code la carga sola en cada sesión de ese
> proyecto, en cualquier máquina.

## Qué estamos construyendo

Frontend (POS de mostrador + tablero de cocina + pantallas admin) para el
backend central del restaurante — NestJS + Postgres.

- **Backend en GitHub**: <URL del repo del backend de este restaurante>
- **Backend desplegado**: <URL del despliegue de este restaurante>
  (Swagger UI en `/docs`, OpenAPI crudo en `/docs-json` — ambos accesibles
  desde cualquier máquina con internet, son la fuente de verdad del contrato)
- **Doc de integración completa**: `docs/pos-integration.md` en ese repo
  (via GitHub si no tenés el repo clonado localmente en esta máquina)

Si tenés el tool WebFetch disponible, leé primero `/docs-json` del backend
desplegado y el `docs/pos-integration.md` de GitHub antes de escribir código.
Si no tenés acceso a internet en esta sesión, lo esencial ya está abajo.

## Decisiones ya tomadas (no las vuelvas a discutir salvo que encuentres un problema real)

| Decisión | Elección |
|---|---|
| Stack | Vite + React + TypeScript (app interna, sin SEO/SSR — Next.js sería peso muerto) |
| Routing | React Router |
| Estado de servidor | TanStack Query |
| Carrito | Zustand + persist (sobrevive a un refresh a mitad de venta) |
| UI | Tailwind + shadcn/ui |
| Formularios | react-hook-form + zod |
| Auth del POS | **Solo JWT de staff** (`POST /auth/login`), nunca un token de servicio en el navegador |
| Tipos de request | Generados desde `/docs-json` con `openapi-typescript` |
| Tipos de response | A mano por ahora (`OrderResponse` etc. son `interface`, no `class` — no generan schema en el OpenAPI) |
| Impresión | Térmica Epson TM-T20III vía Chrome `--kiosk-printing` contra el driver de Windows (no ePOS-Print directo: HTTPS→HTTP plano de la impresora es mixed content bloqueado) |
| Alcance | Venta + cocina + admin, todo en este repo separado del backend |

## Auth — lo único que necesitás saber

Un solo header `Authorization: Bearer <jwt>` en cada request. Se obtiene con
`POST /auth/login` (`{username, password}` → `{accessToken, user:{id,username,role}}`,
role es `admin`|`kitchen`|`cashier`). Dura 8h, no hay refresh token. Todo
`401` = re-login (el backend no distingue "vencido" de "inválido").

El backend tiene un guard compuesto en los endpoints de venta (catálogo,
`POST /orders`, `GET /orders/:id`, cobro en efectivo, clientes) que acepta
tanto un JWT de staff como un token de servicio — el POS usa siempre el JWT.

`forbidNonWhitelisted: true` global: **cualquier campo de más en el body da
400**. Serializá exactamente el contrato, nunca el objeto de estado tal cual.

## Gotchas del contrato que costó descubrir (no los re-derives, ya están verificados)

- **`GET /promotions` no filtra nada** (a diferencia de `/categories` y
  `/products`, que sí). Devuelve archivadas/inactivas/expiradas mezcladas —
  filtrá por `status === 'activa'` en el cliente.
- **`revision` de la promo**: guardalo al armar el carrito, va en
  `POST /orders`. Se incrementa al editar/activar/archivar una promo — un
  carrito viejo con `revision` desactualizado da 409 `promotion_unavailable`.
- **`OrderResponse` trae `items[]` (productos sueltos) Y `promotions[]`**
  (combos, con `componentsSnapshot[]` del detalle). `Σitems.subtotal` NO
  cuadra solo por sí mismo con `subtotalAmount` cuando hay combos — hay que
  sumar también `promotions[].subtotal`. Verificado en producción.
- **Carrito sin duplicados**: no se puede mandar el mismo `productId` dos
  veces — consolidá en una sola línea, `quantity` 1-30. Más de 30 unidades
  del mismo producto en una línea es inexpresable.
- **`Idempotency-Key`**: UUID v4 generado al abrir el carrito (no en el clic
  de confirmar — un doble clic con key nueva cobra dos veces). Mismo uuid en
  reintentos por timeout. **No reordenes `items[]`/`promotions[]` entre
  reintentos** — el hash del body es sensible al orden de los arrays.
  201 = venta nueva, 200 = respuesta cacheada (reimpresión, no recobro).
- **`bypassHoursGate: true` siempre**. `channel` es opcional: con JWT de staff el canal es siempre `pos` (lo deriva el backend de la credencial); si lo mandás con otro valor da `400 channel_mismatch`. `GET /orders` acepta `channel=whatsapp|pos` para filtrar por origen.
- **Tipos de pedido (`deliveryType`)**: `"pickup"` = para llevar desde el
  mostrador, `"dine_in"` = para comer en el local (mesa), `"delivery"` = a
  domicilio (el POS no lo usa hoy). `pickup` y `dine_in` nacen `confirmed`,
  sin ubicación ni costo de envío; el flujo de estados y la regla de pago
  antes de `preparing` son idénticos. En pantalla mostralos como "Para
  llevar" / "Mesa" / "Delivery".
- **Cobro QR real** (Banco Económico): `POST /orders/:id/qr/generate` (rol
  `cashier`/`admin`, exige caja abierta) devuelve
  `{orderId, status, qrImageUrl, dueDate}` — `qrImageUrl` es una ruta
  relativa (`/orders/:id/qr-image`), pedila con el mismo `Authorization:
  Bearer` de siempre (nunca Base64 crudo en el JSON). Es idempotente:
  llamarlo de nuevo para el mismo pedido devuelve el mismo QR, no genera
  otro. La confirmación es **automática** — el backend consulta al banco
  solo cada ~5s — así que el POS solo necesita mostrar el QR y hacer
  polling de `GET /orders/:id` hasta ver `paymentStatus: 'paid'`, mismo
  patrón que el resto del tablero. Si tarda o el banco está caído, hay un
  fallback manual: `POST /orders/:id/payment-attempts/confirm-presencial`
  (no devuelve el pedido, devuelve `{attempt, won}` — pedí `GET /orders/:id`
  después para el ticket).
- **Vencimiento de pedidos sin pagar**: un pedido que a los **20 minutos**
  sigue `unpaid` se cancela solo (`status: cancelled`, `statusUpdatedBy:
  "system"`) y, si tenía QR, se anula en el banco. Aplica al POS igual que a
  WhatsApp; no se cancelan los que ya tienen algo cobrado (una pata de split,
  un pago bancario detectado). El POS debe tratar un pedido que pasa a
  `cancelled` mientras espera el cobro como vencido, no como error. Si el
  banco falla al generar el QR, el fallback es
  `POST /orders/:id/payment-attempts/confirm-presencial` (el cajero confirma
  a mano), dentro de esos 20 minutos.
- **`GET /orders` (tablero, rol `kitchen`/`cashier`/`admin`)**: filtros
  `customer_id`, `status`, `delivery_type`, `payment_status`, `channel` (todos
  snake_case). Array pelado sin `total`. `limit` se recorta a 200 en
  silencio. `status` inválido devuelve `[]` sin avisar. No hay websockets —
  polling cada 5-10s.
- **`409 payment_required`** al intentar `confirmed → preparing` si
  `paymentStatus !== 'paid'` para QR y split; el efectivo pasa sin pago previo
  salvo con `cashPrepaymentRequired` (solo pickup y mesa; el efectivo de
  delivery lo cobra el repartidor).
- **Delivery y repartidores**: cocina lleva el pedido hasta `ready`; de ahí lo
  toma un repartidor con rol `delivery` desde su pantalla (aceptar estando en
  el local, ver detalle, marcar entregado) — contrato en
  `docs/delivery-drivers-integration.md`. `out_for_delivery`/`delivered` de un
  delivery ya no los mueve cocina (`403 delivery_flow_only`), solo el
  repartidor o un admin. `OrderResponse` trae `deliveryDriverName`,
  `deliveryAcceptedAt` y `deliveredAt`. El envío que el cliente paga al
  repartidor solo se informa; no se cuadra en el sistema.
- **Caja (turno)**: NINGÚN cobro (cash o QR) se puede confirmar sin una caja
  abierta — `POST /cash-register/sessions/open {openingAmount}` es la
  primera pantalla del POS antes de poder vender, y
  `GET /cash-register/sessions/current` (cualquier rol logueado) dice si ya
  hay una. Una sola caja abierta a la vez para todo el local, rol
  `admin`/`cashier`. `POST /cash-register/sessions/close
  {countedCashAmount, notes?}` calcula y devuelve, todo ya hecho por el
  backend: `expectedCashAmount`, `cashDifference` (negativo = faltó plata),
  `totalCashSalesAmount`, `totalQrSalesAmount`, `totalSalesAmount` — nunca
  los calcules vos (solo cuentan pedidos ya `paid`, no lo vinculado-pero-sin-
  cobrar todavía). Sin caja abierta, cualquier intento de cobro da
  `409 cash_register_closed` (mostrale al cajero que tiene que abrir caja,
  no es error del pedido). Un pedido fuera de horario (`late-order-requests`)
  se vincula a la caja al **aceptarse**, no al cobrarse — `accept` también
  exige caja abierta y, si no hay, la solicitud queda `pending` sin tocar
  nada (reintentable). Ojo: un pedido tardío en efectivo queda vinculado y
  puede seguir `unpaid` un rato hasta que alguien haga `cash/confirm` — no
  cuenta en el cierre hasta ese momento.
- **El horario del gate ahora es solo un margen ancho de cordura** (ej.
  cerrado 6am-4pm), no el límite preciso — el horario real varía noche a
  noche, así que adentro de ese margen es la **caja** la que decide si un
  pedido se confirma directo o se encola. No afecta al POS (siempre manda
  `bypassHoursGate: true` como siempre, crea el pedido sin importar la
  caja), pero si el tablero también muestra pedidos de WhatsApp podés ver
  aparecer `late_order_requests` en horarios que no son "de madrugada" —
  es esperable, significa que la caja no estaba abierta en ese momento.
- **`status_conflict` (409) ≠ `invalid_state_transition` (409)**: el primero
  es una carrera entre dos pantallas de cocina (CAS optimista) — refrescar y
  reintentar, no mostrar error rojo. El segundo es un salto de estado ilegal.
- **`status` y `paymentStatus` son independientes** — nada impide un pedido
  `delivered` + `unpaid`. Marcalo visualmente, el backend no avisa.
- **Errores**: forma uniforme `{code, message, details}`, salvo los 400 de
  class-validator donde `message` es un **array** de strings, no string.
- **Mantenimiento de menú**: `isAvailable` no se puede mandar a
  `PATCH /products/:id` (da 400) — va solo por
  `PATCH /products/:id/availability` con el campo **`available`** (no
  `isAvailable`). Promociones nuevas nacen inactivas, necesitan un segundo
  call a `PATCH /promotions/:id/active`. `items` de una promo exige 2
  elementos de producto distintos, no cuenta unidades.
- **`GET /categories?includeInactive=true` y `GET /products?includeInactive=true`**
  devuelven también las desactivadas — solo para poder reactivarlas desde el
  mantenimiento de menú, la pantalla de venta usa el endpoint sin el query
  param (que ya filtra).
- **Foto de producto**: cada producto trae `imageUrl` (`null` o una ruta
  relativa `/products/:id/image`, nunca una URL directa al bucket). Como
  `<img src>` no manda headers, hay que `fetch` con el mismo
  `Authorization: Bearer` de siempre y armar
  `URL.createObjectURL(blob)` para el `src` — cacheá el blob en memoria por
  producto. Subir: `POST /products/:id/image` (`{mimeType, fileBase64}`,
  máx. 5MB, rol `admin`, reemplaza la foto anterior si había, no hay
  endpoint para borrarla). El backend acepta bodies JSON de hasta 10MB.

- **Reportería / dashboard** (solo `admin`): `GET /reports/kpis`,
  `sales/timeseries`, `sales/orders`, `sales/orders/:id`, `products/top`,
  `cash-sessions`. Contrato completo en `docs/reports-integration.md` —
  "vendido" = pagado y no cancelado, `from`/`to` son fechas de Bolivia
  (`YYYY-MM-DD`), y para cuadrar con la caja filtrá por `session_id`. Los
  filtros son query params snake_case; no calcules totales en el cliente, el
  backend ya los devuelve.

## Estado del backend (ya hecho y verificado en producción — no lo toques)

CORS configurado (`CORS_ORIGINS` en el entorno de despliegue), guard de auth compuesto, RLS
activado en todas las tablas, seed del primer admin
(`npm run create-admin` en el repo del backend), `OrderResponse` con
`promotions[]`, fotos de producto (S3/R2 o disco local, migración aplicada),
filtros `delivery_type`/`payment_status` en `GET /orders`, gate de
`payment_required` (el efectivo está exento salvo `cashPrepaymentRequired`), límite de body subido a
10MB, horario cruzando medianoche, caja (turno) — apertura/cierre,
vinculación de pedidos al cobrarse (o al aceptarse si son fuera de horario),
cierre con reporte cash/QR/total — y QR real de Banco Económico
(`POST /orders/:id/qr/generate` + confirmación automática por polling al
banco, sección de arriba). Todo probado end-to-end contra el backend real:
login, catálogo con JWT, crear pedido con combo, idempotencia con reintento,
cobro en efectivo, subida y descarga de foto de producto, horario/caja —
cuadró todo. El QR real específicamente: el banco solo validó
`generateQR`/`statusQR`/`cancelQR` en certificación, `statusQrCode = 1`
(pago real) todavía no — así que hasta que el banco habilite esa prueba, la
confirmación automática está construida pero sin poder verificarse de punta
a punta contra un pago real.

Auto-deploy activo: un push a `master` en GitHub redespliega solo en la plataforma de despliegue
(las migraciones **no** corren solas — si alguien agrega una migración nueva,
hay que aplicarla a mano, por `npm run migrate:up` o ejecutando el SQL
contra la base).

## Por dónde arrancar

Esqueleto del proyecto (Vite + React + TS) → cliente HTTP con manejo de JWT
y normalización de errores → pantalla de venta de mostrador. Antes de
escribir código, confirmá que entendiste el contrato de arriba.
