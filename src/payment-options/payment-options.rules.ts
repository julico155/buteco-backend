import { HttpStatus } from '@nestjs/common';
import { DomainException, ValidationError } from '../common/exceptions/domain-exception';
import {
  OrderChannel,
  OrderDeliveryType,
  OrderPaymentMethod,
  PaymentOptionQrScope,
  QrScope,
} from '../database/types';

export interface PaymentOptionRow {
  service_type: OrderDeliveryType;
  payment_method: OrderPaymentMethod;
  qr_scope: PaymentOptionQrScope;
  enabled: boolean;
  /** Canales de origen que pueden usar esta forma de pago. */
  channels: OrderChannel[];
}

export const SERVICE_TYPES: readonly OrderDeliveryType[] = ['delivery', 'pickup', 'dine_in'];

interface PaymentChoice {
  serviceType: OrderDeliveryType;
  paymentMethod: OrderPaymentMethod;
  qrScope?: QrScope | null;
  /**
   * Canal de origen del pedido. Sin él no se valida el canal: lo usan los
   * flujos que no tienen uno (ej. dividir el cobro desde el POS).
   */
  channel?: OrderChannel;
}

function usableBy(row: PaymentOptionRow, channel: OrderChannel | undefined): boolean {
  return channel === undefined || row.channels.includes(channel);
}

/** El QR de un delivery es el único caso donde hay que elegir qué cubre. */
function needsQrScope(serviceType: OrderDeliveryType, paymentMethod: OrderPaymentMethod): boolean {
  return serviceType === 'delivery' && paymentMethod === 'qr';
}

function describe(row: PaymentOptionRow) {
  return {
    serviceType: row.service_type,
    paymentMethod: row.payment_method,
    qrScope: row.qr_scope === 'none' ? null : row.qr_scope,
  };
}

function disabled(choice: PaymentChoice, options: PaymentOptionRow[]): DomainException {
  return new DomainException(
    'payment_method_disabled',
    HttpStatus.BAD_REQUEST,
    'Ese método de pago no está habilitado para este tipo de pedido.',
    {
      serviceType: choice.serviceType,
      paymentMethod: choice.paymentMethod,
      qrScope: choice.qrScope ?? null,
      available: options
        .filter(
          (o) => o.service_type === choice.serviceType && o.enabled && usableBy(o, choice.channel),
        )
        .map(describe),
    },
  );
}

/** La forma de pago está habilitada, pero no para el canal de origen de este pedido. */
function notAllowedForChannel(choice: PaymentChoice, options: PaymentOptionRow[]): DomainException {
  return new DomainException(
    'payment_method_not_allowed',
    HttpStatus.BAD_REQUEST,
    'Ese método de pago no está disponible para este canal de pedido.',
    {
      channel: choice.channel,
      serviceType: choice.serviceType,
      paymentMethod: choice.paymentMethod,
      qrScope: choice.qrScope ?? null,
      available: options
        .filter(
          (o) => o.service_type === choice.serviceType && o.enabled && usableBy(o, choice.channel),
        )
        .map(describe),
    },
  );
}

/** Estado del banco: lo único que hace falta para saber si un cobro con QR es posible. */
export interface BankContext {
  bankConfigured: boolean;
  posQrMode: 'bank' | 'manual';
}

/**
 * ¿El banco permite cobrar con esta forma de pago? Efectivo: siempre. QR y
 * split (su pata QR): con las credenciales del banco cargadas o, solo para
 * presencial y canal POS, en modo manual (el cajero confirma a ojo). Sin
 * `bank` no se valida. Sin `channel` se asume POS (acciones del cajero).
 */
export function bankAllows(params: {
  paymentMethod: OrderPaymentMethod;
  serviceType: OrderDeliveryType;
  channel?: OrderChannel;
  bank?: BankContext;
}): boolean {
  const { bank } = params;
  if (!bank || params.paymentMethod === 'cash' || bank.bankConfigured) return true;
  return (
    (params.channel ?? 'pos') === 'pos' &&
    bank.posQrMode === 'manual' &&
    params.serviceType !== 'delivery'
  );
}

/** Habilitada por el admin, pero el banco no está configurado: no se puede cobrar así. */
function unavailableWithoutBank(choice: PaymentChoice, usable: PaymentOptionRow[]): DomainException {
  return new DomainException(
    'payment_method_disabled',
    HttpStatus.BAD_REQUEST,
    'Ese método de pago no está disponible: el banco no está configurado.',
    {
      reason: 'bank_not_configured',
      serviceType: choice.serviceType,
      paymentMethod: choice.paymentMethod,
      qrScope: choice.qrScope ?? null,
      available: usable
        .filter((o) => o.service_type === choice.serviceType && o.enabled)
        .map(describe),
    },
  );
}

/**
 * Valida que la combinación esté habilitada (y, si se indica el canal, que ese
 * canal pueda usarla, y, si se indica el banco, que se pueda cobrar así) y
 * devuelve el `qr_scope` que hay que guardar en el pedido (null salvo
 * delivery pagado por QR).
 *
 * Apagada → `payment_method_disabled`; prendida pero vedada para el canal →
 * `payment_method_not_allowed`; prendida pero sin banco para cobrarla →
 * `payment_method_disabled` con `details.reason = 'bank_not_configured'`.
 *
 * Delivery + QR sin `qrScope` explícito se resuelve solo cuando no hay
 * ambigüedad: con una única variante habilitada se usa esa; con las dos, se
 * mantiene `food_only` (lo que hacía el sistema antes de existir la opción),
 * así un cliente que no conoce `qrScope` sigue comportándose igual.
 */
export function resolvePaymentOption(
  rawOptions: PaymentOptionRow[],
  choice: PaymentChoice,
  bank?: BankContext,
): QrScope | null {
  const allowedByBank = (o: PaymentOptionRow) =>
    bankAllows({
      paymentMethod: o.payment_method,
      serviceType: o.service_type,
      channel: choice.channel,
      bank,
    });
  // Las alternativas que se ofrecen en un error no incluyen lo que el banco no puede cobrar.
  const options = rawOptions.filter(allowedByBank);
  const candidates = rawOptions.filter(
    (o) => o.service_type === choice.serviceType && o.payment_method === choice.paymentMethod,
  );

  if (!needsQrScope(choice.serviceType, choice.paymentMethod)) {
    if (choice.qrScope) {
      throw new ValidationError('qrScope solo aplica a pedidos de delivery pagados por QR.', {
        serviceType: choice.serviceType,
        paymentMethod: choice.paymentMethod,
      });
    }
    const row = candidates.find((o) => o.qr_scope === 'none');
    if (!row?.enabled) throw disabled(choice, options);
    if (!usableBy(row, choice.channel)) throw notAllowedForChannel(choice, options);
    if (!allowedByBank(row)) throw unavailableWithoutBank(choice, options);
    return null;
  }

  const enabled = candidates.filter((o) => o.enabled);
  if (choice.qrScope) {
    const match = enabled.find((o) => o.qr_scope === choice.qrScope);
    if (!match) throw disabled(choice, options);
    if (!usableBy(match, choice.channel)) throw notAllowedForChannel(choice, options);
    if (!allowedByBank(match)) throw unavailableWithoutBank(choice, options);
    return choice.qrScope;
  }
  if (enabled.length === 0) throw disabled(choice, options);
  const usable = enabled.filter((o) => usableBy(o, choice.channel));
  if (usable.length === 0) throw notAllowedForChannel(choice, options);
  const withBank = usable.filter(allowedByBank);
  if (withBank.length === 0) throw unavailableWithoutBank(choice, options);
  const preferred = withBank.find((o) => o.qr_scope === 'food_only') ?? withBank[0];
  return preferred.qr_scope as QrScope;
}

/** El banco está listo cuando las cinco credenciales del cliente HTTP están cargadas. */
export function isBankConfigured(baneco: {
  baseUrl: string;
  username: string;
  password: string;
  aesKey: string;
  account: string;
}): boolean {
  return [baneco.baseUrl, baneco.username, baneco.password, baneco.aesKey, baneco.account].every(
    (value) => value.trim() !== '',
  );
}

/**
 * Regla: no se puede ACTIVAR una
 * forma de pago con QR si el banco no está configurado. `turningOn` son solo
 * las filas que pasan de apagadas a prendidas — dejar prendida una que ya lo
 * estaba, o apagar, nunca se bloquea. En modo POS manual (`POS_QR_MODE=manual`)
 * el cajero confirma el QR a ojo, así que presencial queda exento; delivery
 * sigue necesitando al banco porque es el QR real el que le llega al cliente.
 */
export function assertBankReadyForQr(params: {
  turningOn: PaymentOptionRow[];
  bankConfigured: boolean;
  posQrMode: 'bank' | 'manual';
}): void {
  if (params.bankConfigured) return;
  const blocked = params.turningOn.filter((row) => {
    if (row.payment_method === 'cash') return false;
    const presencial = row.service_type !== 'delivery';
    return !(presencial && params.posQrMode === 'manual');
  });
  if (blocked.length === 0) return;
  throw new DomainException(
    'bank_not_configured',
    HttpStatus.CONFLICT,
    'No se puede activar un pago con QR: el banco no tiene credenciales configuradas. Cargá las variables BANECO_* o dejá esa forma de pago apagada.',
    { options: blocked.map(describe) },
  );
}

/**
 * Un tipo de servicio sin ninguna forma de pago habilitada no se puede
 * vender: se rechaza apagar la última, en vez de dejar que los pedidos
 * fallen uno por uno.
 */
export function assertEveryServiceHasAnOption(
  options: PaymentOptionRow[],
  serviceTypes: readonly OrderDeliveryType[] = SERVICE_TYPES,
): void {
  const empty = serviceTypes.filter(
    (type) => !options.some((o) => o.service_type === type && o.enabled),
  );
  if (empty.length > 0) {
    throw new DomainException(
      'no_payment_option_enabled',
      HttpStatus.CONFLICT,
      'Cada tipo de servicio necesita al menos una forma de pago habilitada.',
      { serviceTypes: empty },
    );
  }
}

/**
 * Misma regla que `qrChargeAmount`, como expresión SQL sobre `orders` — para
 * sumar lo cobrado por QR en una consulta (cierre de caja). Un solo lugar
 * donde cambiarla si cambia la regla; el spec la ejecuta contra Postgres.
 * Solo para payment_method='qr' (el split suma split_qr_amount).
 */
export const QR_CHARGE_AMOUNT_SQL =
  "(case when qr_scope = 'food_and_delivery' then total_amount else subtotal_amount end)";

/**
 * Cuánto cobra el QR de un pedido: el monto declarado de la pata QR en un
 * split; el total cuando el QR cubre comida + envío; el subtotal en cualquier
 * otro caso (comida sola — en pickup/dine_in subtotal y total coinciden).
 * Devuelve null si es un split sin monto de QR definido.
 */
export function qrChargeAmount(order: {
  payment_method: OrderPaymentMethod;
  qr_scope: QrScope | null;
  subtotal_amount: string;
  total_amount: string;
  split_qr_amount: string | null;
}): number | null {
  if (order.payment_method === 'split') {
    return order.split_qr_amount === null ? null : Number(order.split_qr_amount);
  }
  return Number(order.qr_scope === 'food_and_delivery' ? order.total_amount : order.subtotal_amount);
}
