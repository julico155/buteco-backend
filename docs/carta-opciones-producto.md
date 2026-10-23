# Carta del menú: opciones de producto, disponibilidad por día y aviso de delivery

Contrato **aditivo** para la carta nueva del menú web (tablitas con tamaño, tablas para compartir con carnes a elegir, sopa de
maní solo sábados y domingos). Un producto sin grupos, sin días y sin etiquetas se comporta exactamente como antes; ningún campo
existente cambia de nombre ni de significado.

Migración: `1700000016000_product-options-weekdays-notice.sql`. Rama: `feat/carta-opciones-producto`.

## 1. Modelo

```
producto
 ├─ availableWeekdays   días en que se vende (0 = domingo … 6 = sábado, día calendario de America/La_Paz); null = todos
 ├─ servesLabel         «2 a 3 personas» (aviso de delivery)
 ├─ prepMinutes         minutos de preparación (aviso de delivery)
 └─ grupo de opciones   «Carne 1», «Tamaño»…  (code único dentro del producto)
     ├─ minSelect / maxSelect      cuántas opciones elegir (por defecto 1 y 1)
     ├─ showInNotice               true: lo elegido se nombra en el aviso de delivery (p. ej. «Tamaño»)
     └─ opción                     (code único dentro del grupo)
         ├─ priceDelta             se suma al precio base del producto (≥ 0)
         └─ isAvailable            false = agotada (se acabó esa carne)
```

El `code` de la opción es el contrato con el menú (qué recorte dibujar). Los ids de grupos y opciones **se conservan** al editar el
catálogo (se identifican por `code`), así un carrito en vuelo o el `cart` de un pedido reemplazable siguen siendo válidos.

## 2. `GET /products`

Campos nuevos, **siempre presentes** (valores neutros en los productos de siempre):

```json
{
  "id": "…", "code": "tabla-zeus", "name": "Tabla de Zeus", "price": 175, "isActive": true, "isAvailable": true,
  "servesLabel": "2 a 3 personas",
  "prepMinutes": 40,
  "availableWeekdays": null,
  "isAvailableToday": true,
  "optionGroups": [
    {
      "id": "6f0c…", "code": "carne-1", "name": "Carne 1", "minSelect": 1, "maxSelect": 1, "sortOrder": 0, "showInNotice": false,
      "options": [
        { "id": "a1…", "code": "pollo", "name": "Pollo", "priceDelta": 0, "isAvailable": true, "sortOrder": 0 },
        { "id": "a2…", "code": "costilla-res", "name": "Costilla de res", "priceDelta": 0, "isAvailable": false, "sortOrder": 1 }
      ]
    }
  ]
}
```

Una tablita con tamaño (el precio base es el de 1 persona):

```json
{ "code": "tablita-pollo", "name": "Tablita de pollo", "price": 50, "servesLabel": null, "prepMinutes": 25,
  "optionGroups": [ { "code": "tamano", "name": "Tamaño", "minSelect": 1, "maxSelect": 1, "showInNotice": true, "options": [
    { "code": "1-persona",  "name": "1 persona",  "priceDelta": 0 },
    { "code": "2-personas", "name": "2 personas", "priceDelta": 50 } ] } ] }
```

La sopa de maní:

```json
{ "code": "sopa-mani", "name": "Sopa de maní", "price": 15, "isAvailable": true, "availableWeekdays": [6, 0], "isAvailableToday": false, "optionGroups": [] }
```

- `isAvailable` sigue siendo el flag manual de «agotado» (el que conmuta `PATCH /products/:id/availability`).
- `isAvailableToday` es **solo** la regla de días, calculada para hoy en La Paz. Un producto se vende hoy si `isAvailable && isAvailableToday`.
- Los días de la semana se deciden en una sola función (`isAvailableOnDay`, `src/orders/order-item-options.ts`): día calendario de La Paz.

## 3. `POST /orders` (también `POST /internal/agent/orders/replacements` y las rondas de mesa)

Cada ítem admite `selectedOptions` (opcional, ≤ 20): **solo ids**. Central calcula el precio y valida.

```json
{
  "customerName": "Ana", "deliveryType": "pickup", "paymentMethod": "cash",
  "items": [
    { "productId": "…zeus…", "quantity": 1, "excludedComplements": [],
      "selectedOptions": [ { "groupId": "6f0c…", "optionId": "a1…" }, { "groupId": "6f0d…", "optionId": "b1…" } ] },
    { "productId": "…tablita-pollo…", "quantity": 1,
      "selectedOptions": [ { "groupId": "7a10…", "optionId": "c2…" } ] }
  ]
}
```

Reglas (siempre desde la base, nunca un precio del cliente):

- Precio unitario = precio base + Σ `priceDelta` de lo elegido; subtotal = unitario × cantidad. `unitPriceSnapshot` es el unitario efectivo.
- Cada grupo elegido es del producto y cada opción es del grupo; cada grupo cumple `minSelect`/`maxSelect` (también los que el cliente no tocó).
- La **misma carne en dos grupos distintos** del mismo ítem se permite; dos veces la misma opción dentro de un grupo, no.
- El mismo producto con distintas selecciones son **líneas distintas**; la misma selección (en cualquier orden) repetida es un duplicado (400 `validation_error`).
- Un campo no declarado (por ejemplo un `priceDelta` dentro de la opción) es 400 por `forbidNonWhitelisted`.
- Se guarda un **snapshot** en el ítem: un cambio posterior del catálogo no altera pedidos viejos.
- La huella de idempotencia incluye la selección; sin selección es exactamente la de antes (los reintentos de clientes anteriores no reciben 409).

## 4. Respuestas

`OrderItemResponse` (GET `/orders/:id`, `GET /orders`, respuesta de `POST /orders`, detalle de reportes): la clave `selectedOptions` **solo
aparece en las líneas que tienen opciones**.

```json
{ "productId": "…", "productCodeSnapshot": "tabla-zeus", "productNameSnapshot": "Tabla de Zeus",
  "unitPriceSnapshot": 175, "quantity": 2, "subtotal": 350, "excludedComplements": [], "roundNumber": 1,
  "selectedOptions": [
    { "groupId": "6f0c…", "optionId": "a1…", "groupCode": "carne-1", "groupName": "Carne 1", "optionCode": "pollo", "optionName": "Pollo", "priceDelta": 0 },
    { "groupId": "6f0d…", "optionId": "b1…", "groupCode": "carne-2", "groupName": "Carne 2", "optionCode": "chancho", "optionName": "Chancho", "priceDelta": 0 }
  ] }
```

Cuenta de mesa (`TableAccountResponse.rounds[].items[]`): igual, pero resumido: `selectedOptions: [{ groupName, optionName, priceDelta }]`.

`GET /internal/agent/orders/replaceable` → `cart.items[]`: **solo ids**, exactamente lo que se reenvía a `replacements`. La clave solo aparece si la línea tiene opciones.

```json
{ "result": "replaceable", "orderId": "…", "cart": { "deliveryType": "pickup", "items": [
  { "productId": "…zeus…", "quantity": 1, "excludedComplements": [], "selectedOptions": [ { "groupId": "6f0c…", "optionId": "a1…" }, { "groupId": "6f0d…", "optionId": "b1…" } ] },
  { "productId": "…gaseosa…", "quantity": 2, "excludedComplements": [] } ], "promotions": [] } }
```

Mensaje `qr_confirmation` (`/gateway/whatsapp/messages`): cada ítem de `context.items[]` puede traer `selectedOptions` **con nombres**; solo aparece si la
línea tiene opciones. Los demás mensajes no llevan ítems.

```json
{ "name": "Tabla de Zeus", "quantity": 1, "unitPrice": 175, "subtotal": 175, "excludedComplements": [],
  "selectedOptions": [ { "groupName": "Carne 1", "optionName": "Pollo", "priceDelta": 0 }, { "groupName": "Carne 2", "optionName": "Chancho", "priceDelta": 0 } ] }
```

## 5. Errores

Todos con el formato de siempre: `{ "code", "message", "details" }`.

| Código | HTTP | `details` | Cuándo |
|---|---|---|---|
| `invalid_option_selection` | 400 | `{ reason, productId, groupId?, optionId?, minSelect?, maxSelect? }` con `reason` ∈ `unknown_group`, `unknown_option`, `duplicate_option`, `too_few`, `too_many` | La selección no es válida para ese producto (incluye no haber elegido un grupo obligatorio). |
| `option_unavailable` | 409 | `{ productId, groupId, optionId, unavailableOptionIds[] }` | Una opción elegida está agotada: hay que elegir otra. |
| `product_unavailable` | 409 | `{ productId, reason, unavailableProductIds[], availableWeekdays? }` con `reason` ∈ `inactive`, `sold_out`, **`not_available_today`** | Nuevo `reason`: el producto no se vende hoy; `availableWeekdays` (0 = domingo) dice qué días sí. |
| `promotion_product_requires_options` | 400 | `{ productIds[] }` | Solo al armar una promoción (POS): un producto con opciones obligatorias no puede ser parte de un combo. |

Un combo cuyo componente no se vende hoy cae como cualquier combo con un componente agotado (`promotion_unavailable`). Un pedido fuera de horario (202)
también rechaza en el acto un producto que no se vende hoy.

## 6. Aviso de delivery (Telegram a los repartidores)

- Cada línea: `N x nombre (personas)`. Las personas salen de `servesLabel` del producto o de lo elegido en un grupo con `showInNotice` (el «Tamaño»).
  Las carnes elegidas **no** se nombran. Las líneas se juntan por ese texto: la misma tabla con otras carnes suma; otro tamaño no se mezcla.
- Al final de todo, `Tiempo de preparación: ~40 min`: el **máximo** de `prepMinutes` de los productos del pedido (los combos leen sus componentes del
  catálogo vivo). Si ningún producto lo declara, no se imprime la línea.

```
ORD-0007

Cliente: Ana
Teléfono: https://wa.me/59170000000

Pedido (4 productos):
  2 x Tabla de Zeus (2 a 3 personas)
  1 x Tablita de pollo (1 persona)
  1 x Tablita de pollo (2 personas)

Envío: Bs 13 · 4.8 km

COBRAR ENVÍO

Ubicación: https://www.google.com/maps/search/?api=1&query=-17.78,-63.18
Tiempo de preparación: ~40 min
```

Cambio de formato: antes la cantidad se imprimía pegada (`2x Pizza`); ahora lleva espacios (`2 x Pizza`).

## 7. Endpoints de gestión (POS, JWT de staff)

| Endpoint | Rol | Qué hace |
|---|---|---|
| `PUT /products/:id/option-groups` | `admin` | Reemplaza la lista completa de grupos y opciones del producto. Los existentes se identifican por `code` y **conservan su id**; lo que no viene se borra. |
| `PATCH /products/options/:optionId/availability` | `admin`, `cashier` | `{ "available": false }`: «se acabó esta carne». Devuelve el producto completo. |
| `POST /products`, `PATCH /products/:id` | `admin` | Aceptan `availableWeekdays` (`[6,0]`; en el PATCH `null` = todos los días), `servesLabel` (`null` la borra) y `prepMinutes` (`null` lo borra). |

Cuerpo de `PUT /products/:id/option-groups`:

```json
{ "groups": [
  { "code": "carne-1", "name": "Carne 1", "minSelect": 1, "maxSelect": 1, "options": [
      { "code": "pollo", "name": "Pollo" }, { "code": "chancho", "name": "Chancho" }, { "code": "pescado", "name": "Pescado", "priceDelta": 0, "isAvailable": true } ] } ] }
```

`code`: minúsculas, números y guiones. `maxSelect` no puede superar la cantidad de opciones.

## 8. Orden de despliegue

1. Migración (aditiva) y Central. Con el catálogo actual nada cambia.
2. Tolerancia en el agente y el menú a las claves nuevas (ya verificada por el menú).
3. Cargar el catálogo real (productos, grupos, `servesLabel`, `prepMinutes`, `availableWeekdays` de la sopa) y publicar el menú.
