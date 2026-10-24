# Saldo prepago y comisión del agente

El negocio paga una comisión por cada pedido que le entra por el agente (canal `whatsapp`: el chat y el menú web comparten
credencial). Se descuenta de un saldo prepago que el propio negocio recarga pagando un QR.

## Cómo funciona

| Qué | Regla |
|---|---|
| Quién paga | Pedidos del canal `whatsapp` pagados por **QR**. El POS no paga. El efectivo no genera comisión. |
| Sobre qué | Porcentaje de `subtotal_amount` (productos con promociones aplicadas). **Nunca sobre el envío.** |
| Porcentaje | `AGENT_COMMISSION_PERCENT`. Vacío o `0` apaga todo el mecanismo. Se **congela** en el pedido al crearlo: cambiar la variable no altera pedidos ya hechos. |
| Cuándo se descuenta | Recién cuando el QR queda **cobrado**, en la misma transacción que marca el pedido como `paid`. Crear el pedido no mueve el saldo. |
| Una sola vez | Índice único por pedido: reintentos, cron doble o webhook repetido no cobran dos veces. |
| Cancelación | Si un pedido ya cobrado se cancela (`PATCH /orders/:id/status` → `cancelled`), se **devuelve** la comisión (una sola vez). |
| Sobregiro | El saldo puede quedar hasta `-AGENT_BALANCE_OVERDRAFT_LIMIT` (Bs 10 por defecto). |
| Bloqueo | Al pasar el límite, los pedidos **nuevos** del agente dan `409 agent_service_suspended`. Cuenta lo ya comprometido (pedidos abiertos sin cobrar). |
| Lo que nunca se bloquea | Un cobro que el cliente **ya hizo** en el banco: la comisión se descuenta aunque el saldo pase del límite. |
| Aviso | Con saldo ≤ `AGENT_BALANCE_LOW_THRESHOLD` (Bs 10) se avisa por Telegram (una vez por bajada) y `lowBalance` sale en `GET /billing/balance`. |
| Recarga | QR del banco con el **segundo juego de llaves** (`BANECO_TOPUP_*`). Mínimo `AGENT_TOPUP_MIN_AMOUNT` (Bs 10). |

El saldo es la suma de un libro de movimientos que solo crece (`balance_ledger`): recarga (+), comisión (−), reverso (+) y
ajuste manual (±). Nunca se edita ni se borra una fila.

## Endpoints (todos JWT del personal)

| Ruta | Rol | Qué hace |
|---|---|---|
| `GET /billing/balance` | `admin`, `cashier` | Saldo, comprometido (`reserved`), disponible, `lowBalance`, `suspended`, mínimos, `topupConfigured`. |
| `GET /billing/ledger?limit=&offset=` | `admin`, `cashier` | Movimientos, el más reciente primero (con el número de pedido). |
| `POST /billing/topups` `{amount}` | `admin`, `cashier` | Genera el QR de recarga. `400 topup_below_minimum`, `409 topup_not_configured`. |
| `GET /billing/topups/:id` | `admin`, `cashier` | Estado: `pending` → `confirmed` (o `expired` / `cancelled`). |
| `GET /billing/topups/:id/qr-image` | `admin`, `cashier` | PNG del QR con el monto y el concepto. |
| `POST /billing/adjustments` `{amount, note}` | `admin` | Ajuste manual con signo y motivo. |

El POS genera la recarga, muestra la imagen y consulta `GET /billing/topups/:id` hasta `confirmed`; un cron del backend revisa el
banco cada 10 s. `GET /billing/balance` trae todo lo que hace falta para el aviso de "recargá" y el estado de suspensión.

## Para el agente

- Si un `POST /orders` da **`409 agent_service_suspended`**, el servicio está pausado por saldo: avisarle al cliente que no se
  pueden tomar pedidos por ahora (el mensaje del error ya es apto para el cliente y no revela montos).
- Los pedidos fuera de horario (HTTP 202) pasan por el mismo bloqueo al crearse la solicitud; al aceptarse ya no se vuelve a
  bloquear (sería un rechazo permanente), pero la comisión se congela igual.

## Despliegue

1. Migración `1700000017000` (aditiva: tablas nuevas y dos columnas nulables en `orders`).
2. Con `AGENT_COMMISSION_PERCENT` sin definir **nada cambia**. Para activarlo: definir el porcentaje, cargar las llaves
   `BANECO_TOPUP_*` y hacer una **primera recarga** antes de que el agente tome pedidos (el saldo arranca en 0 y el límite de
   sobregiro es de Bs 10).
3. Probado contra Postgres real: `DATABASE_URL=... npm run test:e2e -- agent-billing`.

## Límites conocidos

- La confirmación de pago depende de que el banco informe el cobro (`statusQR`), que el propio banco todavía no valida de punta a
  punta para pagos reales. Mismo riesgo que el cobro de los pedidos.
- Las llaves de recarga cobran en una cuenta distinta a la del restaurante: la plata de las recargas no entra a su caja.
