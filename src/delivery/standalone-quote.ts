import { DeliveryFee } from './delivery-tariff.service';

export interface StandaloneQuoteAmounts {
  feeAmount: number;
  surchargeAmount: number;
  totalAmount: number;
}

/**
 * Monto final de una cotización sin pedido: tarifa de la banda + recargo por
 * lluvia vigente, con la misma regla que congela `quoteForOrder` en un pedido
 * real (así la cotización previa coincide con lo que después se cobra).
 * Devuelve null cuando no hay tarifa automática (fuera de rango o distancia
 * inválida): ahí no hay monto que sumar.
 */
export function composeStandaloneQuote(
  fee: DeliveryFee,
  rain: { enabled: boolean; amount: number },
): StandaloneQuoteAmounts | null {
  if (!fee.ok) return null;
  // Un envío gratis por política no lleva recargo por lluvia.
  const surchargeAmount = rain.enabled && !fee.free ? rain.amount : 0;
  const totalAmount = Math.round((fee.amount + surchargeAmount) * 100) / 100;
  return { feeAmount: fee.amount, surchargeAmount, totalAmount };
}
