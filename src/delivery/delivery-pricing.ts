import { DeliveryFee } from './delivery-tariff.service';
import { ValidationError } from '../common/exceptions/domain-exception';

export type DeliveryPricingMode = 'bands' | 'fixed' | 'free';

/** Subconjunto de `operational_settings` que decide cuánto cuesta el envío. */
export interface PricingSettings {
  mode: DeliveryPricingMode;
  fixedFee: number | null;
  freeOverAmount: number | null;
  maxDistanceMeters: number | null;
}

/**
 * Techo de reparto automático: más allá, el envío se cotiza a mano. En modo
 * `bands` es la última banda (recortada por el techo configurado, si es
 * menor); en `fixed`/`free` solo existe si hay un techo configurado — null
 * significa "se reparte a cualquier distancia".
 */
export function automaticCeilingMeters(
  settings: Pick<PricingSettings, 'mode' | 'maxDistanceMeters'>,
  bandsMaxMeters: number | null,
): number | null {
  const candidates: number[] = [];
  if (settings.mode === 'bands' && bandsMaxMeters !== null) candidates.push(bandsMaxMeters);
  if (settings.maxDistanceMeters !== null) candidates.push(settings.maxDistanceMeters);
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/**
 * Resuelve el costo de envío según la política del local. `bandFee` solo se
 * invoca en modo `bands` (en los otros no hace falta que existan bandas).
 *
 * El orden importa: primero distancia inválida y techo (esos casos terminan
 * en cotización manual aunque el envío fuera a ser gratis), después la
 * gratuidad, y recién al final la tarifa que corresponda.
 */
export async function resolveDeliveryFee(params: {
  settings: PricingSettings;
  meters: number;
  /** Subtotal del pedido (comida); null si se cotiza sin pedido y sin monto. */
  subtotal: number | null;
  bandFee: () => Promise<DeliveryFee>;
}): Promise<DeliveryFee> {
  const { settings, meters, subtotal } = params;
  if (!Number.isFinite(meters) || meters < 0) {
    return { ok: false, reason: 'invalid_distance' };
  }
  if (settings.maxDistanceMeters !== null && meters > settings.maxDistanceMeters) {
    return { ok: false, reason: 'manual_quote' };
  }

  const freeByThreshold =
    settings.freeOverAmount !== null && subtotal !== null && subtotal >= settings.freeOverAmount;

  if (settings.mode === 'free') {
    return { ok: true, amount: 0, bandIndex: null, free: true };
  }
  if (settings.mode === 'fixed') {
    if (freeByThreshold) return { ok: true, amount: 0, bandIndex: null, free: true };
    return { ok: true, amount: settings.fixedFee ?? 0, bandIndex: null };
  }

  const band = await params.bandFee();
  if (!band.ok) return band;
  if (freeByThreshold) return { ok: true, amount: 0, bandIndex: band.bandIndex, free: true };
  return band;
}

/**
 * Valida el monto que el staff fija a mano en una cotización manual. El tope
 * (`manual_quote_max_amount`) es configurable; el resto son guardas de forma.
 */
export function assertManualQuoteAmount(amount: number, maxAmount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError('El monto debe ser un número finito mayor que cero.');
  }
  if (amount > maxAmount) {
    throw new ValidationError(`El monto excede el máximo de ${maxAmount}.`, { maxAmount });
  }
  if (Math.round(amount * 100) / 100 !== amount) {
    throw new ValidationError('El monto admite como mucho 2 decimales.');
  }
}
