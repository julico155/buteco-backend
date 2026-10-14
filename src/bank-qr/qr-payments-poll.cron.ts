import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { QrPaymentsService } from './qr-payments.service';

/**
 * Mecanismo PRINCIPAL de confirmación mientras `notifyPaymentQR` siga sin
 * validar por el banco (ver manual de integración) — usa `statusQR`, que sí
 * está probado en certificación. El webhook (`bank-qr.controller.ts`)
 * dispara la misma resolución al toque cuando llega, esto es la red de
 * seguridad que igual la revisa sola.
 */
@Injectable()
export class QrPaymentsPollCron {
  private readonly logger = new Logger(QrPaymentsPollCron.name);
  private isRunning = false;

  constructor(private readonly qrPayments: QrPaymentsService) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const qrIds = await this.qrPayments.findPendingQrIds(20);
      for (const qrId of qrIds) {
        try {
          await this.qrPayments.resolveCharge(qrId);
        } catch (error) {
          this.logger.warn(`resolveCharge falló para ${qrId}: ${(error as Error).message}`);
        }
      }
    } finally {
      this.isRunning = false;
    }
  }
}
