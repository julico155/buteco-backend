import { extractQrId } from './notify-payment';

describe('extractQrId (payload de notifyPaymentQR)', () => {
  const qrId = '26091701016545000182';

  // El manual declara el request como un elemento `Payment` de tipo PaymentQR,
  // pero no trae JSON de ejemplo — estas tres formas cubren cómo puede
  // mandarlo el banco sin que se pierda la notificación de un pago real.
  it('lo lee de Payment con P mayúscula, como lo declara el manual', () => {
    expect(extractQrId({ Payment: { qrId, amount: 25.5 } })).toBe(qrId);
  });

  it('lo lee de payment en minúscula', () => {
    expect(extractQrId({ payment: { qrId } })).toBe(qrId);
  });

  it('lo lee del objeto plano', () => {
    expect(extractQrId({ qrId, transactionId: 'ORD-000065' })).toBe(qrId);
  });

  it('prioriza Payment sobre el root cuando vienen los dos', () => {
    expect(extractQrId({ Payment: { qrId }, qrId: 'otro' })).toBe(qrId);
  });

  it('recorta espacios', () => {
    expect(extractQrId({ Payment: { qrId: `  ${qrId}  ` } })).toBe(qrId);
  });

  it('devuelve null si no hay qrId utilizable', () => {
    expect(extractQrId({ Payment: {} })).toBeNull();
    expect(extractQrId({ Payment: { qrId: '' } })).toBeNull();
    expect(extractQrId({ Payment: { qrId: 12345 } })).toBeNull();
    expect(extractQrId({})).toBeNull();
    expect(extractQrId(null)).toBeNull();
    expect(extractQrId('texto suelto')).toBeNull();
  });
});
