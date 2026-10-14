import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiClient } from '../common/decorators/api-client.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { ValidationError } from '../common/exceptions/domain-exception';
import { OrderChannel } from '../database/types';
import { OrderReplacementService } from './order-replacement.service';
import { CreateOrderReplacementDto } from './dto/create-order-replacement.dto';
import { AppendOrderNoteDto } from './dto/append-order-note.dto';

/**
 * api_client -> canal. "Modificar mi pedido" existe para los 2 canales que
 * tienen cliente final propio (WhatsApp y el checkout web) — nunca POS, que
 * ni siquiera llama este controller (usa su propio guard de staff en
 * orders.controller.ts). Cada api_client solo puede resolver/reemplazar el
 * pedido activo de SU PROPIO canal (ver findActiveOrder): una llamada de
 * `web` nunca ve ni toca un pedido de WhatsApp, y viceversa.
 */
const AGENT_API_CLIENT_CHANNEL: Record<string, OrderChannel> = {
  'whatsapp-gateway': 'whatsapp',
  web: 'web',
};

@Controller('internal/agent')
@UseGuards(ServiceAuthGuard)
export class OrderReplacementController {
  constructor(private readonly replacement: OrderReplacementService) {}

  private resolveChannel(apiClient: string): OrderChannel {
    const channel = AGENT_API_CLIENT_CHANNEL[apiClient];
    if (!channel) {
      throw new ForbiddenException('Este endpoint es solo para whatsapp-gateway o web.');
    }
    return channel;
  }

  // Igual que locations/attach: todos los desenlaces son 200 con `result`, son
  // esperados del flujo (no hay pedido, no es modificable...), no errores HTTP.
  @Get('orders/replaceable')
  @HttpCode(200)
  replaceable(@Query('customerPhone') customerPhone: string, @ApiClient() apiClient: string) {
    const channel = this.resolveChannel(apiClient);
    if (!customerPhone) throw new ValidationError('Falta el query param customerPhone.');
    return this.replacement.resolveReplaceable(customerPhone, channel);
  }

  @Post('orders/notes')
  @HttpCode(200)
  appendNote(@Body() dto: AppendOrderNoteDto, @ApiClient() apiClient: string) {
    const channel = this.resolveChannel(apiClient);
    return this.replacement.appendNote(dto, apiClient, channel);
  }

  @Post('orders/replacements')
  async createReplacement(
    @Body() dto: CreateOrderReplacementDto,
    @IdempotencyKey() idempotencyKey: string,
    @ApiClient() apiClient: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const channel = this.resolveChannel(apiClient);
    const outcome = await this.replacement.createReplacement(dto, idempotencyKey, apiClient, channel);
    res.status(outcome.httpStatus);
    return outcome.body;
  }
}
