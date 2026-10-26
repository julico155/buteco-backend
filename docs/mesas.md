# Mesas y cuentas de mesa

> **Desactualizado.** El plano de mesas y las cuentas abiertas ya no son parte del flujo: "mesa" es ahora un pedido simple.
> Ver [mesa-simple-y-reservas.md](mesa-simple-y-reservas.md).

El consumo en el local siempre tiene mesa. Una mesa tiene a lo sumo **una cuenta
viva**: un pedido `dine_in` que se abre al sentar al cliente, recibe consumo en
rondas y se cobra al final (QR, efectivo o dividido).

Todo requiere JWT de staff (`admin` o `cashier`). Dibujar el plano (crear,
mover, borrar mesas y ambientes) es solo del `admin`.

## Plano

| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | `/floors` | admin, cashier | Ambientes (salón, terraza…) |
| POST / PATCH / DELETE | `/floors`, `/floors/:id` | admin | Alta, edición, baja (solo sin mesas) |
| GET | `/tables?floor_id=` | admin, cashier | Mesas con posición, **estado** y resumen de su cuenta |
| GET | `/tables/:id` | admin, cashier | Una mesa |
| POST / PATCH / DELETE | `/tables`, `/tables/:id` | admin | Alta, edición, baja (solo sin historial; si no, desactivar) |
| PUT | `/tables/layout` | admin | Guarda posición/tamaño/giro de varias mesas en una transacción |

Cada mesa trae `x`, `y`, `width`, `height`, `rotation`, `shape`
(`square` / `round` / `rectangle`), `seats` y `floorId`. El editor visual vive en
el POS; el backend solo guarda el plano.

### Estado de la mesa

Se **deduce** de la cuenta viva, no se guarda:

| `state` | Cuándo |
|---|---|
| `free` | Sin cuenta viva |
| `occupied` | Cuenta abierta |
| `bill_requested` | Pidió la cuenta, o la cuenta está cerrada con el cobro (QR) pendiente |
| `out_of_service` | Mesa desactivada y sin cuenta |

`reserved` entra con las reservas (fase posterior).

## Cuenta

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/tables/:id/account` | Abre la cuenta (mesa vacía es válido). Body opcional: `customerName`, `notes` |
| GET | `/tables/:id/account` | Cuenta con sus rondas |
| POST | `/tables/:id/account/rounds` | Suma una ronda. **Requiere `Idempotency-Key`** |
| POST | `/tables/:id/account/items/:itemId/void` | Anula una línea (motivo obligatorio) |
| POST | `/tables/:id/account/promotions/:promotionId/void` | Anula un combo (motivo obligatorio) |
| POST | `/tables/:id/account/bill-request` | "Pidió la cuenta" |
| POST | `/tables/:id/account/close` | Elige cómo se cobra (`cash` / `qr` / `split`) |
| POST | `/tables/:id/account/reopen` | Vuelve a abrir una cuenta cerrada con QR pendiente |
| POST | `/tables/:id/account/cancel` | Cancela una cuenta **sin consumo** |

Reglas:

- Precios y disponibilidad se recalculan en el servidor, igual que un checkout.
- Agregar una ronda borra `billRequestedAt` (el cliente pidió algo más).
- `close` con **efectivo** deja la cuenta cobrada y entregada en un paso.
- `close` con **qr** la deja `confirmed` con cobro pendiente: el POS genera el QR
  con `POST /orders/:id/qr/generate` y la mesa se libera cuando el banco
  confirma. Para agregar consumo antes de pagar, `reopen` cancela ese QR.
- `reopen` falla (`payment_in_progress`) si ya entró plata.
- `POST /orders` con `deliveryType: "dine_in"` se rechaza (salvo canal
  `external`): el consumo en mesa se abre desde la mesa.

### Anular

Anular **no borra**: la línea queda en la cuenta marcada (`voided`, `voidedBy`,
`voidReason`, `voidedAt`), deja de sumar al total y a la comanda, y sigue
apareciendo al revisar la cuenta. No imprime nada en el momento. Solo en cuentas
abiertas: una cuenta ya cerrada se reabre primero.

## Impresión

La imprime el POS; el backend solo manda el detalle. La cuenta (y la respuesta de
`POST .../rounds`) trae `rounds[]` con `roundNumber`, `addedAt` y las líneas de
cada ronda, `notes` y `latestRoundNumber`: la comanda de una ronda es esa
ronda, y la cuenta del cliente es todo `rounds` más `totalAmount`.

## Datos

- `orders.table_id`, `orders.bill_requested_at`, estado `open`.
- `order_items` / `order_promotions`: `round_number`, `added_at` y columnas de
  anulación (`voided_at`, `voided_by`, `void_reason`). El total, la comanda y
  los reportes ignoran lo anulado.
- Índice único parcial: una mesa no puede tener dos cuentas vivas.
- Mientras la cuenta está `open`, `payment_method` queda en `cash` como valor
  provisional; se fija al cerrar.

## Pendiente

- Reservas (adelanto de 100 Bs descontable).
