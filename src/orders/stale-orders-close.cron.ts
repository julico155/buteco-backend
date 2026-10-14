import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppConfig } from '../config/configuration';
import { OrdersService } from './orders.service';

@Injectable()
export class StaleOrdersCloseCron {
  private readonly logger = new Logger(StaleOrdersCloseCron.name);
  private isRunning = false;

  constructor(
    private readonly orders: OrdersService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const hours = this.config.get('staleOrderCloseHours', { infer: true });
      const closed = await this.orders.closeStaleOrders(hours);
      if (closed > 0) this.logger.log(`Cerrados ${closed} pedidos abiertos tras ${hours} h.`);
    } catch (error) {
      this.logger.error(`closeStaleOrders falló: ${(error as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
