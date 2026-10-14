import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { ServiceOrStaffAuthGuard } from '../common/guards/service-or-staff-auth.guard';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { ApiClient } from '../common/decorators/api-client.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentStaffUser } from '../auth/current-staff-user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { OrderChannel, OrderDeliveryType, OrderPaymentStatus, OrderStatus } from '../database/types';
import { OrdersService } from './orders.service';
import { resolveOrderChannel } from './order-channel';
import { CreateOrderDto } from './dto/create-order.dto';
import { AttachLocationDto } from './dto/attach-location.dto';
import { KitchenNoteDto } from './dto/kitchen-note.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { SetSplitPaymentDto } from './dto/set-split-payment.dto';

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get('orders/:id')
  @UseGuards(ServiceOrStaffAuthGuard)
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.findById(id);
  }

  // Pedidos activos (status/limit/offset) y cuadre de caja de fin de
  // noche con las motos (delivery_type=delivery&payment_status=unpaid, ver
  // docs/pos-integration.md) — login de staff (JWT), no el bearer estático
  // del POS, así queda registrado qué persona movió cada pedido
  // (status_updated_by).
  @Get('orders')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('cashier', 'admin')
  @ApiQuery({ name: 'customer_id', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'delivery_type', required: false, type: String })
  @ApiQuery({ name: 'payment_status', required: false, type: String })
  @ApiQuery({ name: 'channel', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  findMany(
    @Query('customer_id') customerId?: string,
    @Query('status') status?: OrderStatus,
    @Query('delivery_type') deliveryType?: OrderDeliveryType,
    @Query('payment_status') paymentStatus?: OrderPaymentStatus,
    @Query('channel') channel?: OrderChannel,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.orders.findMany({
      customerId,
      status,
      deliveryType,
      paymentStatus,
      channel,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Post('orders')
  @UseGuards(ServiceOrStaffAuthGuard)
  async create(
    @Body() dto: CreateOrderDto,
    @IdempotencyKey() idempotencyKey: string,
    @ApiClient() apiClient: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    dto.channel = resolveOrderChannel(apiClient, dto.channel);
    const outcome = await this.orders.create(dto, idempotencyKey, apiClient);
    res.status(outcome.httpStatus);
    return outcome.body;
  }

  @Post('orders/:id/location-request')
  @UseGuards(ServiceAuthGuard)
  @HttpCode(204)
  requestLocation(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.requestLocation(id);
  }

  @Post('orders/:id/location')
  @UseGuards(ServiceAuthGuard)
  attachLocation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachLocationDto) {
    return this.orders.attachLocation(id, dto);
  }

  @Post('orders/:id/kitchen-note')
  @UseGuards(ServiceOrStaffAuthGuard)
  addKitchenNote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: KitchenNoteDto) {
    return this.orders.addKitchenNote(id, dto.note);
  }

  @Post('orders/:id/switch-to-pickup')
  @UseGuards(ServiceAuthGuard)
  switchToPickup(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.switchToPickup(id);
  }

  // Solo JWT de staff, nunca el token de servicio: es una acción
  // exclusivamente presencial (el cajero decidiendo con el cliente adelante).
  @Post('orders/:id/split-payment')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('cashier', 'admin')
  setSplitPayment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetSplitPaymentDto) {
    return this.orders.setSplitPayment(id, dto.cashAmount, dto.qrAmount);
  }

  // Solo JWT de staff: el token de servicio del agente de WhatsApp ya no puede
  // marcar cobros en efectivo (un token filtrado daría pedidos por pagados).
  @Post('orders/:id/cash/confirm')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  confirmCash(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.confirmCash(id);
  }

  @Post('orders/:id/cash/cancel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  cancelCash(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.cancelCash(id);
  }

  @Patch('orders/:id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('cashier', 'admin')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentStaffUser() staffUser: JwtPayload,
  ) {
    return this.orders.updateStatus(id, dto.to, staffUser.username);
  }
}
