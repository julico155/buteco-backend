# Reservas de mesa

> **Desactualizado en lo de las mesas.** Las reservas ya no asignan mesa ni usan `seat`/`move`: el cupo es un máximo de
> personas por día y el adelanto se descuenta como crédito en el pedido de mesa. Ver [mesa-simple-y-reservas.md](mesa-simple-y-reservas.md).

La landing consulta disponibilidad, reserva y paga el adelanto por QR. El
cliente elige **cantidad de personas y horario**; nunca ve qué mesa le toca.

## Reglas

| Regla | Valor (configurable en `/reservation-settings`) |
|---|---|
| Adelanto | 100 Bs (`depositAmount`), se descuenta de la cuenta |
| Bloqueo de la mesa | 2 h desde el horario (`blockMinutes`) |
| Espera al cliente | 30 min desde el horario; si no llega pierde el adelanto (`holdMinutes`) |
| Plazo para pagar el QR | 5 min, mientras tanto la mesa queda bloqueada (`paymentTtlMinutes`) |
| Cancelar con devolución | 4 h o más antes (`cancelRefundHours`); después se pierde |
| Anticipación mínima | 30 min (`minLeadMinutes`) |
| Días hacia adelante | 14 (`maxDaysAhead`) |
| Intervalo de horarios | 30 min (`slotMinutes`) |
| Último horario | 60 min antes del cierre (`lastSlotBeforeCloseMinutes`) |
| Tope de ocupación | 90 % de las mesas activas tomadas a la vez (`maxOccupancyPercent`) |
| Personas por reserva | Hasta las sillas de la mesa más grande (calculado) |

Los horarios salen del horario de atención (`/operational-settings`): solo en
los días que el local abre, entre la apertura y el cierre.

## Cómo se asigna la mesa

Al reservar, el sistema elige **la mesa activa más chica que alcance** y esté
libre en toda la ventana (para 2 personas, una de 2 antes que una de 6). Si
ocuparla pasa el tope de ocupación, ese horario no se ofrece. Las mesas con una
cuenta abierta ahora (clientes sin reserva) cuentan como tomadas para los
horarios que empiezan dentro de lo que dura un servicio. El cajero puede mover
la reserva a otra mesa.

## API de la landing

Usa el token de servicio (`SERVICE_AUTH_TOKENS`, p. ej. `web:<token>`).

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/reservations/availability?date=YYYY-MM-DD&party=2` | Horarios libres, tope de personas y adelanto |
| POST | `/reservations` | Reserva. **Requiere `Idempotency-Key`** |
| GET | `/reservations/:id` | Estado (sincroniza el pago al consultar) |
| POST | `/reservations/:id/cancel` | Cancela; con adelanto pagado aplica la regla de las 4 h |

`POST /reservations` devuelve la reserva en `pending_payment` con
`depositOrderId`. La imagen del QR sale de `GET /orders/:depositOrderId/qr-image`
(mismo token). La landing consulta `GET /reservations/:id` hasta que pase a
`confirmed`, o a `expired` si no pagó en 5 min.

Errores frecuentes (`409`): `no_availability`, `slot_not_available`,
`party_too_large`, `reservations_disabled`. Si el banco no genera el QR, la
reserva se libera y responde `502 qr_generation_failed`.

## Estados

```
pending_payment ──pagó──▶ confirmed ──llegó──▶ seated
      │                      │  └─ 30 min sin llegar ─▶ no_show (adelanto perdido)
      │                      └─ cancela ─▶ cancelled (refund_due o forfeited)
      └─ 5 min sin pagar / sin QR ─▶ expired
```

Estado del adelanto (`depositStatus`): `pending`, `paid`, `applied` (descontado
en la cuenta), `refund_due` (a devolver a mano: el banco no expone API de
devolución), `refunded`, `forfeited` (perdido), `none`.

## Operación en el local (staff)

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/reservations?date=` | Reservas con mesa, teléfono y estado |
| GET | `/reservations/:id/detail` | Una reserva (vista staff) |
| POST | `/reservations/:id/seat` | El cliente llegó: abre la cuenta con el adelanto como crédito. Body opcional `{ tableId }` para otra mesa |
| POST | `/reservations/:id/no-show` | Marca que no se presentó |
| POST | `/reservations/:id/staff-cancel` | Cancela; `refund: true` fuerza la devolución |
| POST | `/reservations/:id/refunded` | Ya se devolvió la plata por fuera |
| PATCH | `/reservations/:id/table` | Cambia la mesa asignada |
| GET/PATCH | `/reservation-settings` | Ajustes (PATCH solo admin) |

En el plano (`GET /tables`) la mesa pasa a `reserved` desde 30 min antes de la
hora, con el resumen en `reservation`.

## Dinero

- El adelanto es un **pedido propio** (`orders.reservation_deposit`) con número
  `RES-0001`: reusa el QR, el sondeo del banco y los reportes. **No aparece en
  `GET /orders`**. Entra aunque la caja esté cerrada.
- Al sentarse, la cuenta guarda `depositCreditAmount` y `totalAmount` es el
  **neto**: lo que ven el QR, el efectivo y el cobro dividido. `grossAmount` es
  el consumo.
- Si el consumo no alcanza el adelanto, no hay nada que cobrar: la cuenta
  cierra sola y el excedente no se devuelve.
- Reportes: el adelanto es una venta de 100 y la cuenta suma el resto, así el
  total de ventas cuadra. Un adelanto devuelto deja de contar (queda cancelado);
  uno perdido cuenta.
- Cuentan como "pedidos" los adelantos en los KPI de cantidad y ticket promedio.

## Procesos periódicos (cada 10 s)

Confirma adelantos pagados, vence los pendientes pasados sus 5 min (cancela su
QR), y marca no presentadas las confirmadas pasados sus 30 min.
