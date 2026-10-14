/**
 * Payload de `notifyPaymentQR` (manual API Market Baneco v1.0.0, sección 6.5
 * + Anexo 1). El manual declara el request como un elemento `Payment` de tipo
 * `PaymentQR`, pero no muestra un JSON de ejemplo — a diferencia del resto de
 * los servicios — así que no está claro si el banco manda `{"Payment": {...}}`,
 * `{"payment": {...}}` o el objeto plano. Se aceptan las tres formas: el qrId
 * es lo único que se usa, y equivocarse acá significa perder la notificación
 * de un pago real.
 */
export interface PaymentQR {
  qrId: string;
  transactionId?: string;
  paymentDate?: string;
  paymentTime?: string;
  currency?: string;
  amount?: number;
  senderBankCode?: string;
  senderName?: string;
  senderDocumentId?: string;
  senderAccount?: string;
}

function readQrId(candidate: unknown): string | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const qrId = (candidate as { qrId?: unknown }).qrId;
  return typeof qrId === 'string' && qrId.trim() !== '' ? qrId.trim() : null;
}

export function extractQrId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const root = body as Record<string, unknown>;
  return readQrId(root.Payment) ?? readQrId(root.payment) ?? readQrId(root);
}
