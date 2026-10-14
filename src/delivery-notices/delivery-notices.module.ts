import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { DeliveryNoticesService } from './delivery-notices.service';

@Module({
  imports: [CommonModule, NotificationsOutModule],
  providers: [DeliveryNoticesService],
  exports: [DeliveryNoticesService],
})
export class DeliveryNoticesModule {}
