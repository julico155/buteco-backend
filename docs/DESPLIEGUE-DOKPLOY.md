# Despliegue en Dokploy

Cada **redeploy** reconstruye la imagen y, antes de arrancar la app, aplica las
migraciones pendientes. No hay que correr nada a mano.

## Cómo funciona

[nixpacks.toml](../nixpacks.toml) define el arranque:

```
npm run migrate:up && npm run start:prod
```

- `migrate:up` aplica **solo lo que falta**. Con nada pendiente responde
  `No migrations to run!` y la app arranca igual.
- Si una migración falla, el comando termina con error y **la app no arranca**:
  el error queda en los logs del despliegue. La migración que falló no queda a
  medias (cada una corre en su transacción).
- `node-pg-migrate` está en `dependencies` (no en `devDependencies`) para que
  siga disponible aunque la imagen se construya sin dependencias de desarrollo.

Probado simulando una imagen sin dependencias de desarrollo sobre una base ya
migrada hasta la 8: aplicó las 9 a 16, la app arrancó y el login respondió; un
segundo redeploy no hizo nada; y una migración rota frenó el arranque.

## Configuración en Dokploy

| Campo | Valor |
|---|---|
| Origen | El repositorio privado `julico155/buteco-backend` (Dokploy necesita acceso al repo: GitHub App o clave de despliegue) |
| Rama | `master` |
| **Build Type** | **Nixpacks**. Con *Dockerfile*, *Railpack* u otro, `nixpacks.toml` se ignora y las migraciones NO se aplican |
| Puerto | El de la variable `PORT` (3000 por defecto); el dominio de Dokploy tiene que apuntar a ese puerto |
| Base de datos | PostgreSQL. `DATABASE_URL` accesible desde la app (en Dokploy, el host interno del servicio) |

Si el despliegue usa un comando de arranque propio en Dokploy, hay que dejarlo
vacío o igual a `npm run migrate:up && npm run start:prod`.

## Variables de entorno

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Conexión a Postgres. La usan la app y las migraciones |
| `JWT_SECRET` | Firma de las sesiones del staff. Larga y aleatoria |
| `SERVICE_AUTH_TOKENS` | Tokens entre servicios, `nombre:token` separados por coma. Incluir el del gateway de WhatsApp (`whatsapp-gateway:...`) y el de la landing (`web:...`) |
| `CORS_ORIGINS` | Dominios del POS y de la landing, separados por coma. Sin esto el navegador los bloquea |
| `BANECO_BASE_URL`, `BANECO_USERNAME`, `BANECO_PASSWORD`, `BANECO_AES_KEY`, `BANECO_ACCOUNT` | Credenciales del banco. Las necesitan las reservas (QR del adelanto) y WhatsApp |
| `POS_QR_MODE` | `manual` mientras el banco no habilite producción para el POS; vacío después. No afecta a la landing ni a WhatsApp |
| `GATEWAY_BASE_URL`, `GATEWAY_AUTH_TOKEN` | Mensajería (WhatsApp y Telegram). Sin esto los avisos salientes quedan desactivados |
| `DELIVERY_NOTICE_CHAT_REF` | Grupo de Telegram de los repartidores |
| `BOOTSTRAP_ADMIN_PASSWORD` | Crea el primer admin al arrancar si no existe ninguno (mínimo 8 caracteres). **Quitarla después** |
| `STALE_ORDER_CLOSE_HOURS` | Opcional (12): horas para cerrar solo un pedido que nadie cerró |

El resto está comentado en [.env.example](../.env.example).

## Antes del primer redeploy sobre una base con datos

1. **Hacer un respaldo de la base** (Dokploy permite programar respaldos de
   Postgres). Las migraciones no tienen vuelta atrás segura.
2. **Mirar qué migraciones ya tiene**: `select name from pgmigrations order by name;`
3. **Tener en cuenta lo que hacen estas dos**, porque modifican datos:
   - `1700000009000_roles-admin-cashier.sql`: los usuarios con rol `kitchen` o
     `delivery` quedan **desactivados** y pasan a `cashier`.
   - `1700000011000_weekly-schedule.sql`: **sobrescribe** el horario de atención
     con el de Buteco (martes a domingo, 12:00 a 23:00, delivery hasta 22:50,
     recojo hasta 22:30). Si la base ya tenía otro horario cargado, se pierde.
4. **Si la base ya tenía aplicada una versión anterior de `1700000016000`**
   (la de la carta con `serves_label_snapshot` y `prep_minutes_snapshot`): esa
   migración no se vuelve a correr, así que esas dos columnas de `order_items`
   quedan de más. Son nulables y el código ya no las usa; se pueden borrar a
   mano: `alter table order_items drop column serves_label_snapshot, drop column prep_minutes_snapshot;`

## Después del redeploy

- Revisar los logs: debe verse `Migrations complete!` y luego el arranque de Nest.
- Entrar con el admin (`POST /auth/login`) y **quitar `BOOTSTRAP_ADMIN_PASSWORD`**.
- La documentación de la API (Swagger) está en `/docs`.

## Datos de arranque (la base queda vacía de esto)

Las migraciones crean tablas, no el contenido del negocio. En una base nueva hay
que cargar:

1. Categorías y productos (con sus grupos de opciones, `availableWeekdays` de la
   sopa de maní, etc.).
2. Bandas de tarifa de delivery y coordenadas del local (`/operational-settings`).
3. Formas de pago habilitadas (`/payment-options`).
4. El plano: ambientes y mesas (`/floors`, `/tables`).
5. Usuarios: el cajero (`POST /auth/users`).
6. Abrir la caja al empezar el turno.

## Orden entre servicios

Primero este backend (con sus migraciones), después el menú y el agente de
WhatsApp. Si el menú sale antes, los clientes ven la carta vacía o con errores.

## Si algo sale mal

- **El despliegue falla en la migración**: la app no arranca. Leer el error en
  los logs, corregir la migración y volver a desplegar. Si ya había una versión
  anterior corriendo, Dokploy puede volver a ella desde el historial de
  despliegues; la base no se revierte sola.
- **Revertir una migración** (`npm run migrate:down`) solo es seguro en la
  última y borra datos de las tablas o columnas que elimina. Preferir restaurar
  el respaldo.
