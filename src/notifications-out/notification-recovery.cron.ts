import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationsOutService } from './notifications-out.service';

/** Camino de recuperación de notification_jobs — ver NotificationsOutService.recoverFailedJobs. */
@Injectable()
export class NotificationRecoveryCron {
  private readonly logger = new Logger(NotificationRecoveryCron.name);

  constructor(private readonly notifications: NotificationsOutService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    const { claimed } = await this.notifications.recoverFailedJobs();
    if (claimed > 0) {
      this.logger.log(`Reintentados ${claimed} notification_jobs pendientes/fallidos.`);
    }
  }
}
