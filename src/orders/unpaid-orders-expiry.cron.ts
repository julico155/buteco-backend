import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppConfig } from '../config/configuration';
import { OrdersService } from './orders.service';

@Injectable()
export class UnpaidOrdersExpiryCron {
  private readonly logger = new Logger(UnpaidOrdersExpiryCron.name);
  private isRunning = false;

  constructor(
    private readonly orders: OrdersService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const ttl = this.config.get('unpaidOrderTtlMinutes', { infer: true });
      const expired = await this.orders.expireUnpaidOrders(ttl);
      if (expired > 0) this.logger.log(`Cancelados ${expired} pedidos sin pagar tras ${ttl} min.`);
    } catch (error) {
      this.logger.error(`expireUnpaidOrders falló: ${(error as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
