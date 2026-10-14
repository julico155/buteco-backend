import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { BanecoModule } from '../baneco/baneco.module';
import { PaymentAttemptsModule } from '../payment-attempts/payment-attempts.module';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { BankQrController } from './bank-qr.controller';
import { QrPaymentsService } from './qr-payments.service';
import { QrPaymentsPollCron } from './qr-payments-poll.cron';

@Module({
  imports: [
    CommonModule,
    AuthModule,
    BanecoModule,
    PaymentAttemptsModule,
    NotificationsOutModule,
  ],
  controllers: [BankQrController],
  providers: [QrPaymentsService, QrPaymentsPollCron],
  exports: [QrPaymentsService],
})
export class BankQrModule {}
