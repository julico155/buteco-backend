import { Module } from '@nestjs/common';
import { GatewayClientModule } from '../gateway-client/gateway-client.module';
import { NotificationsOutService } from './notifications-out.service';
import { NotificationRecoveryCron } from './notification-recovery.cron';

@Module({
  imports: [GatewayClientModule],
  providers: [NotificationsOutService, NotificationRecoveryCron],
  exports: [NotificationsOutService],
})
export class NotificationsOutModule {}
