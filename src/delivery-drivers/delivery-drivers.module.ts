import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { OperationalSettingsModule } from '../operational-settings/operational-settings.module';
import { DeliveryDriversController } from './delivery-drivers.controller';
import { DeliveryDriversService } from './delivery-drivers.service';

@Module({
  imports: [CommonModule, AuthModule, OperationalSettingsModule],
  controllers: [DeliveryDriversController],
  providers: [DeliveryDriversService],
})
export class DeliveryDriversModule {}
