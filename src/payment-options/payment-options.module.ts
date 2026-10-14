import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { OperationalSettingsModule } from '../operational-settings/operational-settings.module';
import { PaymentOptionsController } from './payment-options.controller';
import { PaymentOptionsService } from './payment-options.service';

@Module({
  imports: [CommonModule, AuthModule, OperationalSettingsModule],
  controllers: [PaymentOptionsController],
  providers: [PaymentOptionsService],
  exports: [PaymentOptionsService],
})
export class PaymentOptionsModule {}
