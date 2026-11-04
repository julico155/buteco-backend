import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { BanecoTopupClientService } from './baneco-topup-client.service';
import { BillingController } from './billing.controller';
import { BillingCron } from './billing.cron';
import { BillingService } from './billing.service';

@Module({
  imports: [CommonModule, AuthModule, NotificationsOutModule],
  controllers: [BillingController],
  providers: [BillingService, BillingCron, BanecoTopupClientService],
  exports: [BillingService],
})
export class BillingModule {}
