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
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { OrdersService } from '../orders/orders.service';
import { DeliveryService, OrderQuoteResponse } from './delivery.service';
import { QuoteDeliveryDto } from './dto/quote-delivery.dto';

@Controller()
@UseGuards(ServiceAuthGuard)
export class DeliveryController {
  private readonly logger = new Logger(DeliveryController.name);

  constructor(
    private readonly delivery: DeliveryService,
    @Inject(forwardRef(() => OrdersService)) private readonly orders: OrdersService,
  ) {}

  @Post('delivery/quotes')
  quoteStandalone(@Body() dto: QuoteDeliveryDto, @IdempotencyKey() idempotencyKey: string) {
    return this.delivery.quoteStandalone(dto, idempotencyKey);
  }

  @Post('orders/:id/delivery/quote')
  async quoteForOrder(@Param('id', ParseUUIDPipe) id: string) {
    const quote = await this.delivery.quoteForOrder(id);
    this.sendQrIfJustApplied(id, quote);
    return quote;
  }

  // Recién acá el pedido tiene total final (ver OrdersService.sendQrConfirmationAfterQuote):
  // 'already_applied' es un replay, no dispara nada de nuevo.
  private sendQrIfJustApplied(orderId: string, quote: OrderQuoteResponse): void {
    if (quote.result !== 'applied') return;
    this.orders
      .sendQrConfirmationAfterQuote(orderId)
      .catch((error: Error) =>
        this.logger.warn(`No se pudo notificar QR tras cotizar ${orderId}: ${error.message}`),
      );
  }
}
