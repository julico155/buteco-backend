import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { CashRegisterController } from './cash-register.controller';
import { CashRegisterService } from './cash-register.service';

@Module({
  imports: [CommonModule, AuthModule],
  controllers: [CashRegisterController],
  providers: [CashRegisterService],
  exports: [CashRegisterService],
})
export class CashRegisterModule {}
