# Buteco: qué cambió respecto de la plantilla

Este backend nació como copia de `restaurant-backend-base` (NestJS 10 +
PostgreSQL con Kysely). Este documento resume lo que se decidió y construyó
para adaptarlo a Buteco, en el orden en que se hizo, para que cualquiera que
tome el proyecto entienda **por qué** está como está.

Documentos de detalle: [mesas.md](mesas.md) y [reservas.md](reservas.md).
Varios documentos más antiguos de esta carpeta todavía describen la plantilla
original (cocina, repartidores): ver el apartado
[Documentación desactualizada](#documentación-desactualizada).

## 1. El negocio

- Restaurante de tablitas en Bolivia, hora de La Paz (UTC-4 fijo).
- Atiende **martes a domingo, de 12:00 a 23:00**.
- Modalidades: recojo, delivery propio y consumo en mesa.
- Pagos: efectivo, QR del banco (Baneco, con API que genera y verifica) o
  dividido (efectivo + QR). No hay comprobantes por foto ni validación con IA.
- Un cajero y un administrador. **Una sola impresora térmica**, en caja, que
  maneja el POS.
- La cocina trabaja con la **comanda impresa**: no hay PC ni pantalla en cocina.

## 2. Decisiones de alcance

| Tema | Decisión |
|---|---|
| Roles | Solo `admin` y `cashier`. Se eliminaron `kitchen` y `delivery` |
| KDS (pantalla de cocina) | Fuera de alcance |
| Pantalla del repartidor | Se eliminó. El aviso de delivery sale al grupo de Telegram y el repartidor "toma" respondiendo en el grupo; el sistema no registra quién |
| Tarifa de delivery | Por bandas de distancia (sin cambios), no por zona |
| Promociones y combos | Se mantienen |
| Comprobantes con IA | Descartado: el QR se genera y verifica por la API del banco |
| Tiempo de preparación aproximado | Descartado |
| Aviso de "pedido listo" | Descartado: nadie marca "listo", el cajero entrega directo |

## 3. Qué se construyó, por fase

### Fase 0: punto de partida
- Rename a `buteco-backend` (package.json, lock y README).

### Fase 1: roles y cierre de pedido en un paso
**Problema:** el flujo heredado exigía mover cada pedido por
`preparing → ready → delivered`, pensado para una cocina con pantalla. Acá el
cajero atiende gente y nadie iba a hacerlo.

- Roles reducidos a `admin` y `cashier`. Migración
  `1700000009000_roles-admin-cashier.sql`: los usuarios `kitchen`/`delivery`
  existentes quedan **desactivados** como `cashier` (no se borran).
- Se eliminó el módulo `delivery-drivers` y la regla `delivery_flow_only`. Se
  conservó `delivery-notices` (aviso a Telegram) y `agent-locations` (ubicación
  que manda el agente de WhatsApp).
- **Estados:** recojo y mesa cierran en `delivered` ("Entregado"); delivery
  cierra en `out_for_delivery` ("Despachado"), sin confirmación de entrega.
  `PATCH /orders/:id/status` solo acepta `out_for_delivery`, `delivered` y
  `cancelled`. `preparing` y `ready` ya no se alcanzan (quedan como origen para
  pedidos viejos).
- El **gate de pago** pasó de `preparing` al cierre: QR y split tienen que estar
  `paid` para entregar o despachar; el efectivo se cobra al entregar.
- El efectivo ya **no vence por impago**; el QR sin pagar sigue venciendo a los
  20 min.
- Cron de **cierre automático** (`STALE_ORDER_CLOSE_HOURS`, 12 h) como red de
  seguridad para pedidos que nadie cerró.

### Fase 2: mesas y cuentas abiertas
**Problema:** el consumo en mesa se paga al final y se le agregan cosas durante
la comida. El checkout heredado asumía un pedido cerrado y con forma de pago
conocida desde el inicio.

- Migración `1700000010000_tables-and-open-accounts.sql`.
- **Plano por ambientes:** `floors` y `tables` con posición, tamaño, giro, forma
  y capacidad. El editor visual es del POS; el backend guarda y sirve el plano.
- **Cuenta de mesa = un pedido `dine_in` en estado `open`** con rondas
  (`order_items.round_number`). Un solo pedido porque el banco asocia un QR a
  un pedido y el cliente quiere un QR por el total.
- **Estado de la mesa deducido**, nunca guardado: `free`, `reserved`,
  `occupied`, `bill_requested`, `out_of_service`.
- Índice único parcial: una mesa no puede tener dos cuentas vivas.
- **Anulación:** las líneas no se borran; quedan marcadas (`voided_at`,
  `voided_by`, `void_reason`), siguen apareciendo en la cuenta y no suman al
  total, a la comanda ni a los reportes. El motivo es obligatorio.
- `POST /orders` con `dine_in` se rechaza (salvo canal `external`): el consumo
  en mesa se abre desde la mesa.
- Se extrajo `priceCart` de `createOrderInTransaction` para reusar el cálculo
  de precios en las rondas.
- **Impresión:** la hace el POS; la cuenta devuelve `rounds[]`,
  `latestRoundNumber` y `notes`.

### Fase 3: horario semanal por servicio
- Migración `1700000011000_weekly-schedule.sql`: `open_weekdays`,
  `delivery_last_order_minute`, `pickup_last_order_minute`, y siembra los
  valores de Buteco (martes a domingo, 12:00 a 23:00, delivery hasta 22:50,
  recojo hasta 22:30).
- Lo que entra por **WhatsApp o la web** se rechaza con `409 closed`
  (`details.reason`: `closed_day`, `before_opening`, `after_last_order`) fuera
  de día y hora. **El POS no se bloquea.**
- El horario heredado de "margen ancho + caja abierta" sigue conviviendo
  debajo.

### Fase 4: reservas con adelanto por QR
- Migración `1700000012000_reservations.sql`: `reservation_settings`,
  `reservations`, y en `orders` las columnas `deposit_credit_amount` y
  `reservation_deposit`.
- Reglas (todas configurables en `/reservation-settings`): adelanto de 100 Bs,
  mesa bloqueada 2 h, espera de 30 min, 5 min para pagar el QR, cancelación con
  devolución a 4 h o más, anticipación mínima 30 min, tope de personas = sillas
  de la mesa más grande, tope de ocupación 90 %.
- La mesa se asigna al reservar (la más chica que alcance) y **el cliente nunca
  la ve**.
- El adelanto es un pedido propio (`RES-0001`) que reusa el QR y el sondeo del
  banco. **Entra aunque la caja esté cerrada** (la plantilla dejaba esos pagos
  trabados como "sin aplicar").
- Al sentarse el cliente, la cuenta descuenta el adelanto y su `totalAmount` es
  el **neto**: QR, efectivo y split siguen usando los mismos campos.
- Procesos cada 10 s: confirmar adelantos pagados, vencer los no pagados y
  marcar los que no se presentaron.

### Fase 5: ubicación del checkout web al crear el pedido (M6A)

El menú web de Buteco permite elegir la ubicación en un mapa y cotizar antes de confirmar. Para que ese pedido no vuelva a
pedirle el pin al cliente por WhatsApp, `POST /orders` y los reemplazos aceptan un `deliveryLocation` opcional: el pedido se crea, se ubica y se cotiza en UNA transacción (en vez de "crear y adjuntar después", que dejaba una
ventana en la que `location_request` salía antes de adjuntar la ubicación). Contrato, límites y riesgos en
[gateway-integration.md](gateway-integration.md#ubicación-elegida-en-el-checkout-web-deliverylocation). Migración
aditiva `1700000013000` (ubicación en las solicitudes fuera de horario). Sin cambios para WhatsApp sin ubicación, POS y pickup.

**M6A.1 (autorización por servicio).** Como el menú web usa la credencial de servidor `whatsapp-gateway` (la misma del agente,
canal `whatsapp`), la ubicación se autoriza por **servicio autenticado**: `web` y `whatsapp-gateway`, nada más. El pedido
conserva el canal `whatsapp`; no hay tokens nuevos ni cambios en `SERVICE_AUTH_TOKENS`. POS y `external` siguen rechazados.
Migración aditiva `1700000014000` (la restricción de las solicitudes tardías admite `whatsapp` además de `web`).

### Fase 6: recuperar el resultado de un pedido fuera de horario (M7A)

Un 202 ya se puede recuperar tras una recarga o una respuesta perdida: el reintento con la misma `Idempotency-Key` devuelve el estado actual (con el pedido si fue aceptada) y `GET /late-order-requests/by-key/:key?phone=` lo consulta sin reenviar el carrito, solo con el teléfono del cliente dueño. La clave pasa a ser única por servicio, un reintento con otro contenido da `409`, y el listado y la lectura por UUID de solicitudes quedan solo para staff. Migración `1700000015000`. Detalle en [gateway-integration.md](gateway-integration.md).

### Fase 7: la carta del menú web (opciones de producto)

Tablitas con tamaño, tablas para compartir con carnes a elegir y la sopa de maní solo sábados y domingos. Cada producto puede tener **grupos de opciones**
(`minSelect`/`maxSelect`, con `priceDelta` por opción y opciones agotables); el cliente manda solo ids en `items[].selectedOptions` y Central calcula el precio,
valida y guarda un snapshot en la línea. `products` gana `availableWeekdays` (día calendario de La Paz; Central rechaza el pedido con
`product_unavailable` / `not_available_today`), `servesLabel` y `prepMinutes`. El aviso de delivery a Telegram nombra cada línea con las personas
(`2 x Tabla de Zeus (2 a 3 personas)`) y termina con el tiempo de preparación (el máximo del pedido). Todo es aditivo: sin grupos ni días, nada cambia.
Contrato, ejemplos y errores en [carta-opciones-producto.md](carta-opciones-producto.md). Migración `1700000016000`.

### Filtro por fecha en `GET /orders`
El número de pedido (`ORD-0001`) se reinicia en cada apertura de caja y no lleva
fecha, así que se puede repetir (incluso el mismo día). Para distinguirlos, `GET
/orders` acepta `date=YYYY-MM-DD` (un día) o `from`/`to` (rango, inclusivos), en
**hora de La Paz**: un pedido de las 23:03 del 16 cae en el 16 aunque en UTC ya sea
el 17. Sin esos parámetros no filtra por fecha. `createdAt` sigue viniendo en UTC.

### Fase 7: saldo prepago y comisión del agente

Los pedidos del agente (canal `whatsapp`) pagados por QR descuentan una comisión (`AGENT_COMMISSION_PERCENT`, sobre los productos, sin envío) de un saldo que el negocio recarga con un QR del banco (segundo juego de llaves `BANECO_TOPUP_*`). Se descuenta recién al cobrarse el QR, se devuelve si el pedido cobrado se cancela, y al pasar el sobregiro (`AGENT_BALANCE_OVERDRAFT_LIMIT`) los pedidos nuevos del agente dan `409 agent_service_suspended`. Apagado por defecto. Migración `1700000017000`. Detalle en [saldo-comision.md](saldo-comision.md).

### Fase 8: mesa simple y reservas por personas

"Mesa" pasa a ser un pedido simple para consumir en el local (sin plano ni cuenta abierta), cobrado antes de cocinar como el de recojo. Las reservas dejan de asignar mesa: el cupo es un máximo de personas por día (`maxPeoplePerDay`, 30) y el adelanto se descuenta como crédito en el pedido de mesa del cliente (`reservationId`). Se quitan `seat` y `move`. Migración `1700000018000`. Detalle en [mesa-simple-y-reservas.md](mesa-simple-y-reservas.md).

## 4. Cómo se verificó

| Qué | Resultado |
|---|---|
| `tsc --noEmit` | Sin errores |
| jest | 57 suites, 442 tests en verde |
| Migraciones | Las 12 aplican de punta a punta en Postgres 16 real (Docker) |
| Recorrido de mesas y anulación | 30 + 23 comprobaciones contra la API real, todas bien |
| Recorrido de reservas | 39 comprobaciones contra la API real con un banco simulado |

**No verificado:**
- Contra el **banco real**: solo se probó con un simulado que imita sus
  endpoints (`generateQR`, `statusQR`, `cancelQR`).
- La suite **e2e** de `test/` (necesita Postgres real). Se corrió contra Postgres 16:
  pasan `idempotency`, `payment-attempts-concurrency` y `product-options`; **fallan
  3 suites (19 tests)**: `web-location`, `agent-locations` y
  `order-replacement-concurrency`. Fallaban igual antes de integrar la carta
  (comprobado sobre `27c3456`): arman los servicios a mano con un `config` vacío
  (`this.config.get is not a function`). Hay que actualizar esos tests.
- Las integraciones con el gateway de WhatsApp/Telegram y con Mapbox.
- Los scripts de recorrido contra la API real **no están en el repo** (se
  corrieron desde una carpeta temporal).

## 5. Despliegue

1. `npm ci`
2. Variables de entorno (ver `.env.example`):
   - `DATABASE_URL`, `JWT_SECRET`, `SERVICE_AUTH_TOKENS` (incluir el token de la
     landing, p. ej. `web:<token>`, y el del gateway de WhatsApp).
   - `BANECO_BASE_URL`, `BANECO_USERNAME`, `BANECO_PASSWORD`, `BANECO_AES_KEY`,
     `BANECO_ACCOUNT`.
   - `POS_QR_MODE=manual` mientras el banco no habilite producción para el POS;
     vacío después. **No afecta** a la landing ni a WhatsApp: esos siempre usan
     el QR real.
   - `STALE_ORDER_CLOSE_HOURS` (opcional, 12 por defecto).
   - `BOOTSTRAP_ADMIN_PASSWORD` para crear el primer admin al arrancar (quitarla
     después), o `npm run create-admin`.
3. `npm run migrate:up` (el despliegue con nixpacks migra al arrancar).
4. Variables eliminadas: `DELIVERY_ACCEPT_RADIUS_METERS` y
   `DELIVERY_NEARBY_RADIUS_METERS`.

## 6. Limitaciones y cosas a tener presentes

- **Devolver un adelanto es manual:** el banco no expone API de devolución. La
  reserva queda `refund_due` y el cajero marca `refunded` al devolver la plata.
- **Un QR de mesa pendiente vence a los 20 min** (cron de impagos común). Si el
  cliente tarda más, la cuenta se cancela y la mesa se libera.
- **`payment_method` queda en `cash` como valor provisional** mientras la
  cuenta está `open`; se fija al cerrar. Es un atajo para no volver nulable una
  columna que toca todo el sistema.
- **Los adelantos cuentan como pedidos** en los KPI de cantidad y ticket
  promedio. El total de ventas cuadra.
- **Las cuentas vacías canceladas** cuentan como pedidos cancelados en reportes.
- El horario de atención es **uno solo** para todos los días abiertos.
- Un pedido de **recojo/mesa en efectivo** que nadie cierra se cierra solo a las
  12 h sin cobro registrado.
- Los valores por defecto de reservas que no se hablaron (intervalo de 30 min,
  14 días de adelanto, último horario 60 min antes del cierre) los puso quien
  implementó: conviene revisarlos.
- **No hay aviso por WhatsApp** de confirmación de reserva, ni reserva cargada
  por teléfono con el adelanto pagado en el local.

## 7. Pendiente

- Subir el repositorio a un remoto (hoy solo existe en una PC).
- Credenciales de Baneco de producción y salir de `POS_QR_MODE=manual`.
- Avisos por WhatsApp de reservas.
- Mover los recorridos de prueba a una suite de integración dentro del repo.
- Revisar o retirar los documentos viejos de esta carpeta.

## Documentación desactualizada

Estos documentos conservan el texto de la plantilla y mencionan cocina,
repartidores o `preparing`/`ready`: `gateway-integration.md`,
`NUEVO-RESTAURANTE.md`, `plantilla-cambios-para-pos.md`,
`pos-frontend-handoff.md`, `pos-integration.md` y `reports-integration.md`. El
README tiene una nota al inicio con el resumen de los cambios.
