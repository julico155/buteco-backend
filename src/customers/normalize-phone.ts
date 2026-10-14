/**
 * Forma canónica del teléfono de un cliente: `+` y los dígitos con código de
 * país (E.164). Es la ÚNICA función que decide eso — findOrCreate, findByPhone
 * y los endpoints internos del agente pasan por acá, para que `+591…` y
 * `591…` sean el mismo cliente.
 *
 * Nunca asume un país: solo agrega el `+` cuando el número ya trae su código.
 * - Con `+` o prefijo internacional `00`: se conserva/convierte a `+`.
 * - Solo dígitos, con `assumeInternational` (el `wa_id` de WhatsApp siempre
 *   incluye país): se agrega `+`.
 * - Solo dígitos sin esa garantía: se agrega `+` únicamente si parece
 *   internacional (11 a 15 dígitos y sin 0 inicial). Cualquier otra cosa es un
 *   número local y se devuelve tal cual, sin `+`, en vez de inventar un país.
 *   Límite conocido: un local de 11 dígitos sin 0 inicial se tomaría por
 *   internacional, y uno internacional de 10 o menos dígitos por local.
 * Siempre se quitan espacios, guiones, puntos y paréntesis.
 */
export function normalizePhone(raw: string, options: { assumeInternational?: boolean } = {}): string {
  const stripped = raw.trim().replace(/[\s\-.()]/g, '');

  if (stripped.startsWith('+')) {
    const digits = stripped.slice(1).replace(/\D/g, '');
    return digits === '' ? stripped : `+${digits}`;
  }
  if (/^00\d+$/.test(stripped)) return `+${stripped.slice(2)}`;

  if (/^\d+$/.test(stripped)) {
    const looksInternational =
      stripped.length >= 11 && stripped.length <= 15 && !stripped.startsWith('0');
    return options.assumeInternational || looksInternational ? `+${stripped}` : stripped;
  }
  return stripped;
}
