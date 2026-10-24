import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BillingService } from './billing.service';

/** Revisa las recargas pendientes contra el banco y avisa si el saldo bajó del umbral. */
@Injectable()
export class BillingCron {
  private readonly logger = new Logger(BillingCron.name);
  private isRunning = false;

  constructor(private readonly billing: BillingService) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.billing.pollPendingTopups();
      await this.billing.checkLowBalance();
    } catch (error) {
      this.logger.warn(`Revisión de saldo falló: ${(error as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
