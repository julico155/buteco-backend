# Carga del catálogo real de la carta

Script: [`scripts/load-carta.mjs`](../scripts/load-carta.mjs). Carga por la **API admin** de Central (no toca la base, no necesita SSH) los productos de la carta
nueva: 7 tablitas, 6 tablas para compartir, 6 bebidas con o sin tamaño y la sopa de maní solo sábados y domingos. Contrato que genera:
[carta-opciones-producto.md](carta-opciones-producto.md).

Solo necesita Node 20+ (el mismo del repo). No instala nada.

## Cómo se corre

Siempre primero el **dry-run** (es el modo por defecto: solo lee y muestra la tabla, no escribe nada):

```bash
CENTRAL_URL=https://<url-de-central> \
CENTRAL_ADMIN_USER=<usuario admin> \
CENTRAL_ADMIN_PASSWORD=<contraseña> \
node scripts/load-carta.mjs
```

(en PowerShell: `$env:CENTRAL_URL='…'; $env:CENTRAL_ADMIN_USER='…'; $env:CENTRAL_ADMIN_PASSWORD='…'; node scripts/load-carta.mjs`)

Después de revisar la tabla y de que el dueño la apruebe, el mismo comando con `--apply`:

```bash
node scripts/load-carta.mjs --apply
```

| Variable | Qué es |
|---|---|
| `CENTRAL_URL` | URL base de Central, sin barra final. |
| `CENTRAL_ADMIN_USER` | Usuario con rol `admin`. |
| `CENTRAL_ADMIN_PASSWORD` | Su contraseña. Se escribe en la terminal en el momento; nunca en el archivo, en el repo ni en un commit. |

Opciones: `--dry-run` (por defecto), `--apply`, `--prep-file=ruta.json` (tiempos de preparación del dueño, ver abajo) y `--help`.

## Qué hace y qué no

- **Idempotente por `code`**: crea lo que falta, actualiza solo lo que cambió y deja igual lo demás. Se puede correr las veces que haga falta; la segunda vez el plan sale "sin cambios".
- Crea las categorías **Para compartir** y **Extras** si faltan (el menú reparte los productos por el nombre de su categoría: Tablitas, Para compartir, Bebidas, Extras).
- Los grupos y opciones se cargan con `PUT /products/:id/option-groups`: los ids se conservan por `code`, y una carne que la cocina dejó **agotada** sigue agotada al volver a correr el script.
- **Desactiva** (`isActive=false`) los 6 productos viejos: Tablita Mixta, Tablita de Pollo (la vieja, `TAB-002`), Tablita Familiar, Coca-Cola 500ml, Cerveza Paceña y Jugo de Naranja. **Nunca borra** (la API no tiene `DELETE` y borrar rompería el historial). Los busca por nombre y solo entre los productos que no son de la carta nueva, así la "Tablita de pollo" nueva (`tablita-pollo`) no se confunde con la vieja.
- **No toca**: ajustes operativos (horarios, delivery, pagos), caja, coordenadas, las categorías `Prueba` y `Pruebas`, el producto de prueba de Bs 0,01 ni ningún otro producto. Los productos activos que quedan fuera de la carta se **listan** en el plan, con la marca de si se verían en el menú, para que alguien decida.

## Qué revisar en el dry-run

1. Las categorías a crear y los 20 productos a crear (o "sin cambios" si ya estaban).
2. **Precios**: los de tablitas y tablas son los del volante, confirmados contra las imágenes. Las **bebidas y la sopa no salen en el volante**: las bebidas aparecen marcadas "precio por confirmar".
3. **Tiempos de preparación**: el volante dice tablitas "30 a 40 minutos" (se usa 40) y tablas para compartir "45 a 1 hora" (se usa 60); bebidas y sopa quedan sin tiempo. El campo admite un solo número. Para poner los del dueño, un archivo JSON (fuera del repo si prefieres) y `--prep-file`:

   ```json
   { "tablita-pollo": 35, "tabla-zeus": 50, "super-tabla-xl": 75, "sopa-mani": 15, "limonada": null }
   ```

   Un código que no existe en la carta es un error. Los códigos están en la tabla del dry-run.
4. **Productos viejos a desactivar** y **otros productos activos** que el script no toca.

## Pruebas

```bash
node --test scripts/load-carta.test.mjs
```

13 pruebas del plan (sin red ni base): estructura que espera el menú, precios de 1 y 2 personas, productos viejos, idempotencia, y que la carne agotada se conserva.

Además se probó de punta a punta contra un Central local con la forma que tiene producción (categorías Prueba, Tablitas, Bebidas, Entradas y Pruebas y 8 productos viejos): el dry-run no escribe nada, el `--apply` crea 20 productos y 2 categorías y desactiva solo los 6 viejos, la segunda corrida da "sin cambios", y el humo de pedidos con carnes y de la sopa pasa contra el catálogo cargado.
