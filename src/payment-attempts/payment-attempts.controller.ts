import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { ServiceOrStaffAuthGuard } from '../common/guards/service-or-staff-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PaymentAttemptsService } from './payment-attempts.service';
import { DecidePaymentAttemptDto } from './dto/decide-payment-attempt.dto';

@Controller()
export class PaymentAttemptsController {
  constructor(private readonly paymentAttempts: PaymentAttemptsService) {}

  @Get('orders/:id/payment-attempts')
  @UseGuards(ServiceOrStaffAuthGuard)
  findByOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentAttempts.findByOrder(id);
  }

  @Post('payment-attempts/:id/decide')
  @UseGuards(ServiceAuthGuard)
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecidePaymentAttemptDto) {
    return this.paymentAttempts.decide(id, dto.decision);
  }

  // Cobro presencial en el POS: cajero revisa el QR a simple vista y
  // confirma en el momento — requiere login de staff, no el bearer del POS.
  @Post('orders/:id/payment-attempts/confirm-presencial')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('cashier', 'admin')
  confirmPresencial(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecidePaymentAttemptDto) {
    return this.paymentAttempts.confirmPresencial(id, dto.decision);
  }
}
