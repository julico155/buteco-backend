import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ServiceOrStaffAuthGuard } from '../common/guards/service-or-staff-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentStaffUser } from '../auth/current-staff-user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { ApiClient } from '../common/decorators/api-client.decorator';
import { channelForApiClient } from '../orders/order-channel';
import { PaymentOptionsService } from './payment-options.service';
import { UpdatePaymentOptionsDto } from './dto/update-payment-options.dto';

@Controller('payment-options')
export class PaymentOptionsController {
  constructor(private readonly paymentOptions: PaymentOptionsService) {}

  /** Qué formas de pago acepta el local — los frontends pintan solo las `enabled`. */
  @Get()
  @UseGuards(ServiceOrStaffAuthGuard)
  list(@ApiClient() apiClient: string) {
    return this.paymentOptions.list(channelForApiClient(apiClient));
  }

  @Patch()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  update(
    @Body() dto: UpdatePaymentOptionsDto,
    @CurrentStaffUser() staffUser: JwtPayload,
    @ApiClient() apiClient: string,
  ) {
    return this.paymentOptions.update(
      dto.options.map((o) => ({
        serviceType: o.serviceType,
        paymentMethod: o.paymentMethod,
        qrScope: o.qrScope ?? null,
        enabled: o.enabled,
        channels: o.channels,
      })),
      staffUser.username,
      channelForApiClient(apiClient),
    );
  }
}
