import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { OperationalSettingsModule } from '../operational-settings/operational-settings.module';
import { PaymentOptionsModule } from '../payment-options/payment-options.module';
import { BankQrModule } from '../bank-qr/bank-qr.module';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';
import { TableAccountsService } from './table-accounts.service';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { ReservationsCron } from './reservations.cron';

@Module({
  imports: [
    CommonModule,
    AuthModule,
    OrdersModule,
    OperationalSettingsModule,
    PaymentOptionsModule,
    BankQrModule,
  ],
  controllers: [TablesController, ReservationsController],
  providers: [TablesService, TableAccountsService, ReservationsService, ReservationsCron],
  exports: [TablesService],
})
export class TablesModule {}
