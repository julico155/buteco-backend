import { HttpStatus } from '@nestjs/common';
import { DomainException, ValidationError } from '../common/exceptions/domain-exception';
import { STAFF_API_CLIENT } from '../common/guards/service-or-staff-auth.guard';
import { OrderChannel } from '../database/types';

/**
 * Canal de origen de un pedido según la CREDENCIAL con que llegó, nunca según
 * lo que diga el body: el JWT de staff (POS/dashboard) es `pos` y cada token de
 * servicio mapea a su propio canal. Así un cliente no puede hacerse pasar por
 * otro para saltarse las reglas de su canal.
 */
const CHANNEL_BY_API_CLIENT: Record<string, OrderChannel> = {
  [STAFF_API_CLIENT]: 'pos',
  'whatsapp-gateway': 'whatsapp',
  web: 'web',
  // POS ajeno que reporta sus ventas (ya cobradas) para cocina y métricas.
  external: 'external',
};

/** Canal de una credencial, o undefined si no tiene uno (no lanza). */
export function channelForApiClient(apiClient: string | undefined): OrderChannel | undefined {
  return apiClient === undefined ? undefined : CHANNEL_BY_API_CLIENT[apiClient];
}

export function resolveOrderChannel(apiClient: string, declared?: OrderChannel): OrderChannel {
  const channel = CHANNEL_BY_API_CLIENT[apiClient];
  if (!channel) {
    throw new ValidationError(`El cliente de servicio "${apiClient}" no tiene un canal de pedidos asignado.`);
  }
  if (declared !== undefined && declared !== channel) {
    throw new DomainException(
      'channel_mismatch',
      HttpStatus.BAD_REQUEST,
      `Esta credencial solo puede crear pedidos del canal "${channel}", pero el body declara "${declared}".`,
      { expected: channel, declared },
    );
  }
  return channel;
}
