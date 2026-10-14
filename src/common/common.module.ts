import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ServiceAuthGuard } from './guards/service-auth.guard';
import { ServiceOrStaffAuthGuard } from './guards/service-or-staff-auth.guard';
import { IdempotencyService } from './idempotency/idempotency.service';

@Module({
  imports: [AuthModule],
  providers: [ServiceAuthGuard, ServiceOrStaffAuthGuard, IdempotencyService],
  // AuthModule se re-exporta porque @UseGuards(ServiceOrStaffAuthGuard)
  // instancia el guard en el contexto del módulo que lo usa, y ahí tiene que
  // poder resolver JwtAuthGuard.
  exports: [AuthModule, ServiceAuthGuard, ServiceOrStaffAuthGuard, IdempotencyService],
})
export class CommonModule {}
