/**
 * Gate de horario de atención (invariante 7 del plan). Portado de
 * del sistema anterior, pero el horario real
 * no es fijo (varía ±1h noche a noche): `opensHour`/`closesHour` ya no son
 * el límite preciso de apertura/cierre, son solo un margen ANCHO de cordura
 * (ej. cerrado de 6am a 4pm) para descartar de una un mensaje claramente
 * fuera de cualquier horario plausible. Adentro de ese margen, quien decide
 * de verdad si se toma el pedido directo o se encola para revisión humana
 * es la caja: abierta -> proceed, cerrada -> late_review (que ya exige caja
 * abierta para aceptarse, ver LateOrderRequestsService.accept). Así una
 * noche que cierra una hora antes deja de tomar pedidos apenas cierran la
 * caja, sin que nadie tenga que tocar operational_settings; y una noche que
 * se extiende sigue tomando pedidos mientras la caja siga abierta.
 *
 * El turno real del local cruza la medianoche (ej. 19 a 4). Las
 * comparaciones se hacen con la hora normalizada RELATIVA a `opensHour`
 * (aritmética modular de 24hs), no con la hora absoluta del día — así
 * "19 a 4" se convierte internamente en "0 a 9" y las mismas comparaciones
 * `>=` de siempre vuelven a ser válidas sin importar que crucen la
 * medianoche.
 *
 * Bolivia es UTC-4 todo el año (no observa horario de verano desde 1932) —
 * el fallback aritmético solo se usa si el runtime no trae Intl con zonas.
 */
export const SERVICE_TIME_ZONE = 'America/La_Paz';
const BOLIVIA_UTC_OFFSET_MS = -4 * 60 * 60 * 1000;

/** Clasificación puramente horaria — el margen ancho de cordura, nada más. */
export type ServiceWindow = 'open' | 'closed';

export interface ServiceHours {
  opensHour: number;
  closesHour: number;
}

function hourInBolivia(instant: Date): number | null {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: SERVICE_TIME_ZONE,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(instant);
    const raw = parts.find((p) => p.type === 'hour')?.value;
    if (raw === undefined) return hourByArithmetic(ms);
    const hour = Number.parseInt(raw, 10);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return hourByArithmetic(ms);
    return hour;
  } catch {
    return hourByArithmetic(ms);
  }
}

function hourByArithmetic(ms: number): number | null {
  const local = new Date(ms + BOLIVIA_UTC_OFFSET_MS);
  const hour = local.getUTCHours();
  return Number.isInteger(hour) ? hour : null;
}

/** Horas desde la apertura, en [0, 24) — hace que cruzar la medianoche sea aritmética normal. */
function hoursSinceOpen(hour: number, opensHour: number): number {
  return ((hour - opensHour) % 24 + 24) % 24;
}

/**
 * Frontera en punto, ya normalizada relativa a `opensHour` (ver comentario
 * de cabecera). Un instante ilegible (NaN) sale 'closed': ante la duda, no
 * se toma un pedido que nadie va a cocinar.
 */
export function classifyServiceWindow(instant: Date, hours: ServiceHours): ServiceWindow {
  const hour = hourInBolivia(instant);
  if (hour === null) return 'closed';
  const relHour = hoursSinceOpen(hour, hours.opensHour);
  const relCloses = hoursSinceOpen(hours.closesHour, hours.opensHour);
  return relHour >= relCloses ? 'closed' : 'open';
}

export type CheckoutGate = { gate: 'proceed' } | { gate: 'late_review' } | { gate: 'closed' };

/**
 * `cashRegisterOpen` es lo que separa `proceed` de `late_review` adentro
 * del margen horario — ver comentario de cabecera del archivo. Afuera del
 * margen es `closed` sin importar la caja: no tiene sentido encolar un
 * mensaje que llegó a las 10am.
 */
export function checkoutGateAt(
  instant: Date,
  hours: ServiceHours,
  cashRegisterOpen: boolean,
): CheckoutGate {
  if (classifyServiceWindow(instant, hours) === 'closed') return { gate: 'closed' };
  return cashRegisterOpen ? { gate: 'proceed' } : { gate: 'late_review' };
}

/** Qué hacer con un pedido que llega dentro del margen horario pero sin caja abierta. */
export type OutOfHoursPolicy = 'queue' | 'reject' | 'accept';

/**
 * Aplica la política del local al resultado de `checkoutGateAt`. Solo cambia
 * `late_review` (el pedido "fuera de horario" por caja cerrada): `queue` lo
 * encola para aprobación humana (lo de siempre), `reject` lo rechaza como
 * cerrado y `accept` lo toma directo. `closed` (fuera del margen ancho)
 * nunca cambia: no hay horario plausible en el que cocinarlo.
 */
export function applyOutOfHoursPolicy(gate: CheckoutGate, policy: OutOfHoursPolicy): CheckoutGate {
  if (gate.gate !== 'late_review') return gate;
  if (policy === 'reject') return { gate: 'closed' };
  if (policy === 'accept') return { gate: 'proceed' };
  return gate;
}

/**
 * "Día de negocio" para numerar pedidos cuando no hay caja que lo ancle: el
 * turno cruza la medianoche, así que el día calendario partiría la numeración
 * a mitad de noche. Se desplaza el instante `closesHour` horas hacia atrás:
 * todo el turno cae en la misma fecha. La etiqueta de la fecha no importa,
 * solo que sea la misma durante todo el turno.
 */
export function businessDayKey(instant: Date, closesHour: number): string {
  return dateInBolivia(new Date(instant.getTime() - closesHour * 60 * 60 * 1000));
}

/** Fecha calendario en Bolivia, formato YYYY-MM-DD — usado para `dueDate` del QR bancario. */
export function dateInBolivia(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SERVICE_TIME_ZONE }).format(instant);
}

/** Instante UTC en que empieza el día calendario `date` (YYYY-MM-DD) en Bolivia — Bolivia es UTC-4 fijo. */
export function startOfBoliviaDay(date: string): Date {
  return new Date(`${date}T00:00:00-04:00`);
}

/** Vigencia por defecto de una solicitud fuera de horario; en la app sale de LATE_ORDER_REQUEST_TTL_MINUTES. */
export const LATE_REQUEST_TTL_MS = 20 * 60 * 1000;

export function lateRequestExpiryFor(instant: Date, ttlMs: number = LATE_REQUEST_TTL_MS): Date {
  return new Date(instant.getTime() + ttlMs);
}
