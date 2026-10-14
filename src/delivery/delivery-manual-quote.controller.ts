import {
  Body,
  Controller,
  forwardRef,
  Inject,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ServiceOrStaffAuthGuard } from '../common/guards/service-or-staff-auth.guard';
import { OrdersService } from '../orders/orders.service';
import { DeliveryService } from './delivery.service';
import { ManualQuoteDto } from './dto/manual-quote.dto';

/**
 * Cotización manual de un delivery fuera del techo automático. Aparte de
 * `DeliveryController` (solo token de servicio) porque la decide una persona:
 * la puede fijar el gateway (el staff contesta por Telegram) o el staff
 * directamente desde el dashboard con su JWT (`admin` / `cashier`). Con el
 * token de servicio `RolesGuard` no exige rol (ya es confianza entre backends).
 */
@Controller()
@UseGuards(ServiceOrStaffAuthGuard, RolesGuard)
@Roles('admin', 'cashier')
export class DeliveryManualQuoteController {
  private readonly logger = new Logger(DeliveryManualQuoteController.name);

  constructor(
    private readonly delivery: DeliveryService,
    @Inject(forwardRef(() => OrdersService)) private readonly orders: OrdersService,
  ) {}

  @Post('orders/:id/delivery/quote/manual')
  async setManualQuote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ManualQuoteDto) {
    const quote = await this.delivery.setManualQuote(id, dto.amount);
    // Recién acá el pedido tiene total final: 'already_applied' es un replay.
    if (quote.result === 'applied') {
      this.orders
        .sendQrConfirmationAfterQuote(id)
        .catch((error: Error) =>
          this.logger.warn(`No se pudo notificar QR tras cotizar ${id}: ${error.message}`),
        );
    }
    return quote;
  }
}
