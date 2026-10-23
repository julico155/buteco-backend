# Bitácora

## 2026-10-23 · GRAD
- backend: carta del menú. Opciones de producto (`selectedOptions`, `optionGroups`), disponibilidad por día (`availableWeekdays`, sopa de maní `[6,0]`) y `servesLabel`/`prepMinutes`. Migración `1700000016000`. Rama `feat/carta-opciones-producto`.
- backend: aviso de delivery a Telegram con las personas por línea (`2 x Tabla de Zeus (2 a 3 personas)`) y, al final, el tiempo de preparación (máximo del pedido). Rama `feat/carta-opciones-producto`.
- backend: entorno LOCAL de pruebas en `.central-test/` (sin commit, excluido de git): Postgres desechable en el puerto 54329 y Central en el 3100, con tokens aleatorios y todo lo externo apagado. Incluye siembra de la carta (datos de prueba) y control del día de la sopa. Rama `feat/carta-opciones-producto`.
- backend: Subida: 2 repos, 2 ramas. buteco-backend va en `feat/carta-opciones-producto` y Agente-Buteco en `restaurar-menu-maqueta`. Orden de despliegue: PRIMERO Central (migración `1700000016000` y código), DESPUÉS el menú y el agente; si el menú llegara antes, los clientes verían la carta vacía o con errores.
