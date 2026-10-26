# Mesa como pedido simple y reservas por personas

> **Reemplaza** lo que decían [mesas.md](mesas.md) y [reservas.md](reservas.md) sobre el plano, las cuentas abiertas, la
> asignación de mesa y los endpoints `seat` / `move`. Esas guías quedan como historia.

## Qué cambió

1. **"Mesa" ahora es un pedido simple** para consumir en el local, igual que "para llevar": sin plano de mesas, sin cuenta
   abierta, sin rondas. Se crea y se **cobra antes de cocinar**.
2. **Las reservas ya no usan mesas.** El cupo es un **máximo de personas por día** (30 por defecto): la suma de los grupos con
   reserva no puede pasar de ese tope.
3. **El adelanto de la reserva (Bs 100) es un crédito a favor** que se descuenta del pedido de mesa cuando el cliente llega.

Las mesas y los pisos siguen existiendo en el backend y en la base de datos, pero ya **no los usa nada**: ni las reservas ni la
venta. El POS deja de mostrarlos.

## Pedido de mesa

`POST /orders` (JWT de `cashier` o `admin`; header `Idempotency-Key`):

```json
{ "customerName": "Mesa 4", "deliveryType": "dine_in", "paymentMethod": "qr",
  "items": [{ "productId": "…", "quantity": 2 }], "reservationId": "…(opcional)" }
```

- Nace `confirmed` y `unpaid`, como un recojo. Se cobra con los endpoints de siempre (`qr/generate`, `cash/confirm`,
  `confirm-presencial`, `split-payment`). Con `cashPrepaymentRequired` prendido, el efectivo también se exige antes de cocinar.
- **Solo lo toma el cajero (POS)** o un POS ajeno (`external`). El agente (WhatsApp) y la web reciben `400 validation_error`.
- Las formas de pago salen de `GET /payment-options` (servicio `dine_in`).
- Lo viejo (`/tables/:id/account…`, `/floors`, `/tables`) **sigue respondiendo** pero ya no es parte del flujo.

## Reservas

| Regla | Valor (configurable en `/reservation-settings`) |
|---|---|
| Cupo | `maxPeoplePerDay`: personas con reserva el mismo día (30). Reemplaza a `maxOccupancyPercent` |
| Adelanto | `depositAmount` (100 Bs), se descuenta del consumo |
| Espera al cliente | `holdMinutes` (30) desde el horario; si no llega pierde el adelanto |
| Pago del adelanto | `paymentTtlMinutes` (5) |
| Cancelar con devolución | `cancelRefundHours` (4) o más de anticipación |
| Horarios | cada `slotMinutes`, dentro del horario de atención, con `minLeadMinutes` de anticipación y hasta `maxDaysAhead` días |

- **Disponibilidad** (`GET /reservations/availability?date=&party=`): si el grupo cabe en el día, ofrece **todos** los horarios
  del día; si no, ninguno (`slots: []`). `maxPartySize` ahora es `maxPeoplePerDay`.
- **Crear** (`POST /reservations`): `409 no_availability` si el grupo ya no cabe ese día; `409 party_too_large` si el grupo solo
  ya pasa el máximo. Dos solicitudes a la vez nunca se pasan del cupo (se serializan por día).
- Cancelar, "no se presentó" y devolución del adelanto funcionan como antes. Una reserva cancelada **libera** sus lugares.
- **Ya no existen** `POST /reservations/:id/seat` ni `PATCH /reservations/:id/table`. `tableId`, `tableLabel` y `tableSeats`
  desaparecieron de la respuesta del staff.

## Cuando el cliente llega: el adelanto como crédito

El cajero crea el pedido de mesa con el `reservationId`:

- El pedido nace **neto** del adelanto: `subtotalAmount` y `totalAmount` ya descuentan el crédito, y `depositCreditAmount` dice
  cuánto fue. Un consumo de Bs 140 con adelanto de 100 → `depositCreditAmount: 100`, `totalAmount: 40`.
- **Si el adelanto cubre todo el consumo** (Bs 60 con adelanto de 100) el pedido nace **pagado** (`payment_method: cash`), sin
  nada que cobrar. **Lo que sobra del adelanto no se devuelve ni queda a favor** (por ahora no hay conciliación).
- La reserva queda `seated` (adelanto `applied`) y apunta al pedido en `accountOrderId`. **Una reserva se usa una sola vez**:
  dos pedidos simultáneos con la misma reserva → solo uno recibe el crédito, el otro `409 reservation_already_used`.
- Errores: `409 reservation_not_usable` (adelanto sin pagar, cancelada, no presentada), `409 reservation_expired` (pasó el plazo
  para llegar), `404` (no existe), `400` si el pedido no es `dine_in` del POS.

El adelanto sigue siendo un pedido propio (`reservation_deposit`) cobrado por QR al reservar: entra a los reportes como venta
cuando se paga, y el pedido de mesa del cliente cuenta solo el neto, así no se cobra dos veces.

## Despliegue

- Migración `1700000018000` (aditiva): `reservations.table_id` admite null y `reservation_settings.max_people_per_day`
  (30 por defecto). Las reservas anteriores **conservan su mesa**; no se borra nada. `migrate:up` la aplica sola en el redeploy.
- **El POS actual deja de funcionar en dos pantallas** al desplegar: sentar y mover reservas, y el campo `maxOccupancyPercent` de
  los ajustes. Hay que desplegar el POS nuevo junto con este cambio.
- Probado contra Postgres real: `DATABASE_URL=... npm run test:e2e -- dine-in-reservations`.
