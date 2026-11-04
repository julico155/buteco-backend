import { ValidationError } from './exceptions/domain-exception';

/** Canales con visibilidad de catálogo propia (flags `sell_on_*` en products y promotions). */
export type CatalogChannel = 'whatsapp' | 'pos';

export const CATALOG_CHANNELS: CatalogChannel[] = ['whatsapp', 'pos'];

export const SELL_ON_COLUMN = {
  whatsapp: 'sell_on_whatsapp',
  pos: 'sell_on_pos',
} as const;

/** Tokens de servicio cuyo catálogo queda fijo por credencial, sin importar lo que pidan. */
const CATALOG_CHANNEL_BY_SERVICE_CLIENT: Record<string, CatalogChannel> = {
  'whatsapp-gateway': 'whatsapp',
};

/**
 * Canal por el que hay que filtrar un GET de catálogo, o `undefined` para no
 * filtrar. El gateway de WhatsApp siempre ve el catálogo de WhatsApp (la
 * credencial manda, no el query). El staff (POS/dashboard comparten
 * `apiClient = 'pos'`) ve todo salvo que pida un canal con `?channel=`, así
 * el dashboard de admin sigue pudiendo editar lo que está apagado en un canal.
 */
export function resolveCatalogChannel(
  apiClient: string,
  requested?: string,
): CatalogChannel | undefined {
  const fixed = CATALOG_CHANNEL_BY_SERVICE_CLIENT[apiClient];
  if (fixed) return fixed;
  if (requested === undefined || requested === '') return undefined;
  if (!CATALOG_CHANNELS.includes(requested as CatalogChannel)) {
    throw new ValidationError(`channel debe ser uno de: ${CATALOG_CHANNELS.join(', ')}.`);
  }
  return requested as CatalogChannel;
}

/** Canal de un pedido → flag que decide si ahí se vende suelto; `undefined` si ese canal no filtra (ej. web). */
export function catalogChannelOfOrder(channel: string): CatalogChannel | undefined {
  return CATALOG_CHANNELS.includes(channel as CatalogChannel) ? (channel as CatalogChannel) : undefined;
}
