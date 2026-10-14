import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppConfig } from '../config/configuration';
import { isBankConfigured } from '../payment-options/payment-options.rules';
import { OrdersService } from './orders.service';

/**
 * Reintenta generar el QR real de los pedidos cuyo primer intento falló
 * (banco caído o lento). Sin banco configurado no hace nada: reintentar un
 * banco que no existe solo llenaría el log.
 */
@Injectable()
export class QrRetryCron {
  private readonly logger = new Logger(QrRetryCron.name);
  private isRunning = false;

  constructor(
    private readonly orders: OrdersService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async run(): Promise<void> {
    if (this.isRunning) return;
    if (!isBankConfigured(this.config.get('baneco', { infer: true }))) return;
    this.isRunning = true;
    try {
      const ttlMinutes = this.config.get('unpaidOrderTtlMinutes', { infer: true });
      const attempted = await this.orders.retryPendingQrCharges({ ttlMinutes });
      if (attempted > 0) this.logger.log(`Reintentado el QR de ${attempted} pedidos.`);
    } catch (error) {
      this.logger.error(`retryPendingQrCharges falló: ${(error as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
