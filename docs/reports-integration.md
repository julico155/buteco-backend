# Reportería y KPIs (`/reports`)

Módulo de solo lectura (`Authorization: Bearer <jwt>`). **`admin`** ve todo.
**`cashier` y `kitchen`** ven `kpis`, `sales/timeseries` y `products/top`;
**`cashier`** además `sales/orders` y `sales/orders/:id`. `cash-sessions`
es solo `admin`. Cualquier otro rol o endpoint da 403. Sin tablas nuevas: agrega sobre `orders`,
`order_items`, `order_promotions`, `payment_attempts`, `bank_qr_charges` y
`cash_register_sessions`. Los dos índices que usa (`orders.created_at`,
`orders.register_session_id`) ya vienen en el baseline de `migrations/`.

## Reglas comunes

- **Vendido** = `payment_status = 'paid'` **y** `status <> 'cancelled'` (igual
  que el cierre de caja, que solo suma pedidos ya pagados). Los KPIs de
  cancelados y sin pagar se reportan aparte.
- **Fechas**: `from` / `to`, formato `YYYY-MM-DD`, **hora de Bolivia**, ambas
  inclusivas, filtran por `orders.created_at`. Sin `to` = hoy; sin `from` =
  30 días hasta `to`. Máximo 366 días.
- **Turno de caja** (`session_id`, UUID): como el turno cruza la medianoche,
  es el "día de negocio" real. Con `session_id` y sin fechas no se acota por
  fecha. Es el filtro correcto para cuadrar contra el cierre de caja.
- Montos como `number`, timestamps ISO. Errores de validación: 400
  `validation_error`.
- Filtros comunes (todos opcionales, snake_case): `from`, `to`,
  `session_id`, `channel` (`whatsapp|web|pos`), `payment_method`
  (`qr|cash`), `payment_status`
  (`unpaid|pending_review|paid|rejected`), `status`, `delivery_type`
  (`delivery|pickup|dine_in` — a domicilio, para llevar, mesa), `sold` (`true` = solo vendidos).

## Endpoints

| Endpoint | Qué devuelve |
|---|---|
| `GET /reports/kpis` | `totalOrders`, `sold {orders, salesAmount, averageTicket}`, `cancelled {orders, rate}`, `unpaid {orders, amount}`, `byChannel[]`, `byPaymentMethod[]`, `byDeliveryType[]` (cada uno `{key, orders, salesAmount}` sobre lo vendido, ordenado por monto) y `lateOrderRequests {total, byStatus}` (`null` si se filtra por turno sin fechas). |
| `GET /reports/sales/timeseries?group_by=day\|hour` | `points[] {bucket, orders, salesAmount}` de lo vendido; `bucket` = `YYYY-MM-DD` o `YYYY-MM-DDTHH:00`, en hora de Bolivia. |
| `GET /reports/sales/orders?limit&offset` | Lista paginada (default 50, tope 200, más nuevos primero) con ítems y combos resumidos, más `totals {orders, amount}` del filtro **completo** (no de la página). |
| `GET /reports/sales/orders/:id` | Desglose completo: montos, entrega, timestamps (`createdAt`, `confirmedAt`, `cashConfirmedAt`, `updatedAt`), cliente, `items[]`, `promotions[]` con `componentsSnapshot`, `paymentAttempts[]`, `bankQrCharges[]` (sin imagen ni payloads crudos) y `cashRegisterSession` vinculada. |
| `GET /reports/products/top?limit` | `products[]`, `combos[]` (top por ingreso, default 10, tope 100) y `categories[]` — siempre sobre pedidos vendidos. |
| `GET /reports/cash-sessions?from&to&limit&offset` | Historial de turnos (mismo shape que `/cash-register/sessions`): esperado vs contado, diferencia, totales cash/QR/total. Filtra por `opened_at`. |

## Límites conocidos

- No hay historial de estados: **no** hay tiempos de preparación por etapa.
  Hacerlo requiere una tabla `order_status_history` nueva y solo valdría
  hacia adelante.
- La hora de cancelación solo se aproxima con `updatedAt`.
- El ranking por categoría usa la categoría **actual** del producto
  (`order_items` no guarda snapshot de categoría).
- Los pedidos se ubican por fecha de creación, no de cobro: un pedido creado
  antes de medianoche y pagado después cuenta en el día en que se creó (usar
  `session_id` para el corte por turno).
