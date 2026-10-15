import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentOptionsModule } from '../payment-options/payment-options.module';
import { BankQrModule } from '../bank-qr/bank-qr.module';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';
import { TableAccountsService } from './table-accounts.service';

@Module({
  imports: [CommonModule, AuthModule, OrdersModule, PaymentOptionsModule, BankQrModule],
  controllers: [TablesController],
  providers: [TablesService, TableAccountsService],
  exports: [TablesService],
})
export class TablesModule {}
