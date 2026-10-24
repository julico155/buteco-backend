import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, sql, Transaction } from 'kysely';
import { DomainException } from '../common/exceptions/domain-exception';
import { AppConfig } from '../config/configuration';
import { Database, OrderChannel, OrderPaymentMethod } from '../database/types';

/**
 * Comisión del agente contra un saldo prepago. Todo vive en funciones sobre `Kysely`/`Transaction` (sin inyección) porque lo
 * llaman tres módulos que ya existen — pedidos, pagos y el propio módulo de saldo — y así ninguno depende de otro.
 *
 * Reglas:
 *   - "Agente" es el canal `whatsapp` (lo que entra con la credencial del gateway: el chat y el menú web). El POS no paga comisión.
 *   - La comisión es un porcentaje del SUBTOTAL de los productos (con promociones aplicadas), nunca del envío.
 *   - Se CONGELA al crear el pedido, pero recién se DESCUENTA cuando el QR queda cobrado (`chargeCommission`, en la misma
 *     transacción que marca el pedido como pagado). Si el pedido se cancela estando pagado, se devuelve (`reverseCommission`).
 *   - El límite de sobregiro frena pedidos NUEVOS; jamás un cobro que el cliente ya hizo en el banco.
 *   - Con `AGENT_COMMISSION_PERCENT` sin definir (0) nada de esto se activa.
 */

type Db = Kysely<Database> | Transaction<Database>;

export type AgentBillingConfig = AppConfig['agentBilling'];

/**
 * Configuración activa, o `null` si la comisión está apagada. Tolerante a una forma inesperada (los tests inyectan un
 * `ConfigService` falso que contesta lo mismo a cualquier clave): ante la duda, apagado.
 */
export function agentBillingConfig(config: ConfigService<AppConfig, true>): AgentBillingConfig | null {
  const raw = config.get('agentBilling', { infer: true }) as Partial<AgentBillingConfig> | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const percent = Number(raw.commissionPercent);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return {
    commissionPercent: percent,
    overdraftLimit: Number.isFinite(Number(raw.overdraftLimit)) ? Number(raw.overdraftLimit) : 10,
    lowBalanceThreshold: Number.isFinite(Number(raw.lowBalanceThreshold)) ? Number(raw.lowBalanceThreshold) : 10,
    topupMinAmount: Number.isFinite(Number(raw.topupMinAmount)) ? Number(raw.topupMinAmount) : 10,
  };
}

/** `true` si un pedido con este canal y forma de pago paga comisión (agente + QR: es lo que se cobra y se puede verificar). */
export function paysAgentCommission(channel: OrderChannel, paymentMethod: OrderPaymentMethod): boolean {
  return channel === 'whatsapp' && paymentMethod === 'qr';
}

/** Comisión en Bs sobre un subtotal, redondeada al centavo (mitad hacia arriba). Cuenta en centavos para no arrastrar decimales. */
export function commissionFor(subtotal: number, percent: number): number {
  const cents = Math.round(subtotal * 100);
  return Math.round((cents * percent) / 100) / 100;
}

export async function getBalance(db: Db): Promise<number> {
  const row = await sql<{ balance: string }>`select coalesce(sum(amount), 0)::text as balance from balance_ledger`.execute(db);
  return Number(row.rows[0]?.balance ?? 0);
}

/**
 * Comisión de los pedidos del agente que siguen abiertos y sin cobrar: todavía no se descontó, pero ya está "comprometida".
 * Sin contarla, varios pedidos pendientes a la vez podrían pasarse del límite juntos al pagarse.
 */
export async function getReservedCommissions(db: Db): Promise<number> {
  const row = await sql<{ reserved: string }>`
    select coalesce(sum(agent_commission_amount), 0)::text as reserved
    from orders
    where agent_commission_amount is not null
      and payment_status = 'unpaid'
      and status <> 'cancelled'
  `.execute(db);
  return Number(row.rows[0]?.reserved ?? 0);
}

/** Cuánto saldo queda libre para pedidos nuevos: lo que hay menos lo ya comprometido. */
export async function getAvailable(db: Db): Promise<{ balance: number; reserved: number; available: number }> {
  const [balance, reserved] = await Promise.all([getBalance(db), getReservedCommissions(db)]);
  return { balance, reserved, available: Math.round((balance - reserved) * 100) / 100 };
}

/**
 * Bloqueo de pedidos nuevos del agente: si tomar este pedido deja el saldo disponible por debajo del límite de sobregiro,
 * se rechaza con un código propio. El mensaje es para el agente/cliente: no revela montos del negocio.
 */
export async function assertAgentCanOrder(db: Db, cfg: AgentBillingConfig, newCommission: number): Promise<void> {
  const { available } = await getAvailable(db);
  if (available - newCommission < -cfg.overdraftLimit) {
    throw new DomainException(
      'agent_service_suspended',
      HttpStatus.CONFLICT,
      'Por ahora no podemos tomar pedidos por este canal. Intentá de nuevo más tarde.',
    );
  }
}

/**
 * Descuenta la comisión de un pedido. Idempotente: una sola fila `commission` por pedido (índice único), así que reintentar el
 * cobro, un cron que corre dos veces o un webhook repetido no cobran dos veces. No hace nada si el pedido no tiene comisión.
 * Va en la misma transacción que marca el pedido como pagado: o se cobró todo, o nada.
 */
export async function chargeCommission(trx: Db, orderId: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    insert into balance_ledger (type, amount, order_id, note)
    select 'commission', -o.agent_commission_amount, o.id, 'Comisión del pedido ' || o.order_number
    from orders o
    where o.id = ${orderId}
      and o.agent_commission_amount is not null
      and o.payment_method = 'qr'
    on conflict (order_id, type) do nothing
    returning id
  `.execute(trx);
  return result.rows.length > 0;
}

/**
 * Devuelve la comisión de un pedido que ya se había cobrado y luego se canceló. Idempotente (una sola fila de reverso por
 * pedido) y sin efecto si nunca se cobró.
 */
export async function reverseCommission(db: Db, orderId: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    insert into balance_ledger (type, amount, order_id, note)
    select 'commission_reversal', -l.amount, l.order_id, 'Pedido cancelado: se devuelve la comisión'
    from balance_ledger l
    where l.order_id = ${orderId} and l.type = 'commission'
    on conflict (order_id, type) do nothing
    returning id
  `.execute(db);
  return result.rows.length > 0;
}
