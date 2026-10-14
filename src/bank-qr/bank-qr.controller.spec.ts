import { Logger } from '@nestjs/common';
import { BankQrController } from './bank-qr.controller';

describe('BankQrController', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not log an unrecognized bank notification payload', async () => {
    const qrPayments = {
      recordNotifyPayload: jest.fn().mockResolvedValue(undefined),
      resolveCharge: jest.fn(),
    };
    const controller = new BankQrController(qrPayments as never);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const sensitivePayload = { phone: '59170000000', account: 'sensitive-account' };

    await expect(controller.notifyPayment(sensitivePayload)).resolves.toEqual({
      responseCode: 1,
      message: 'Falta qrId en la notificación.',
    });

    expect(warn).toHaveBeenCalledWith('notifyPaymentQR missing recognizable qrId');
    expect(String(warn.mock.calls[0][0])).not.toContain('59170000000');
  });
});
