import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { OperationalSettingsModule } from '../operational-settings/operational-settings.module';
import { CashRegisterModule } from '../cash-register/cash-register.module';
import { OrdersModule } from '../orders/orders.module';
import { OrderReplacementController } from './order-replacement.controller';
import { OrderReplacementService } from './order-replacement.service';

@Module({
  imports: [CommonModule, OperationalSettingsModule, CashRegisterModule, OrdersModule],
  controllers: [OrderReplacementController],
  providers: [OrderReplacementService],
})
export class OrderReplacementModule {}
