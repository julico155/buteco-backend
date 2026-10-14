import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentStaffUser } from '../auth/current-staff-user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { DeliveryDriversService } from './delivery-drivers.service';
import { AcceptDeliveryOrderDto } from './dto/accept-delivery-order.dto';
import { ConfirmDeliveryDto } from './dto/confirm-delivery.dto';
import { parsePagination } from '../reports/reports.range';

/** Pantalla del repartidor. Solo rol `delivery` (o `admin` como override). */
@Controller('delivery/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('delivery', 'admin')
export class DeliveryDriversController {
  constructor(private readonly drivers: DeliveryDriversService) {}

  @Get('available')
  listAvailable() {
    return this.drivers.listAvailable();
  }

  @Get('mine')
  listMine(@CurrentStaffUser() staffUser: JwtPayload) {
    return this.drivers.listMine(staffUser.sub);
  }

  // Método propio: el cajero también puede ver el historial (cuadre de fin de noche).
  @Get('history')
  @Roles('delivery', 'admin', 'cashier')
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'driver_id', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  listHistory(
    @CurrentStaffUser() staffUser: JwtPayload,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('driver_id', new ParseUUIDPipe({ optional: true })) driverId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const page = parsePagination(limit, offset);
    return this.drivers.listHistory(staffUser, { from, to, driverId, ...page });
  }

  @Post(':id/accept')
  accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptDeliveryOrderDto,
    @CurrentStaffUser() staffUser: JwtPayload,
  ) {
    return this.drivers.accept(id, staffUser, dto);
  }

  @Post(':id/deliver')
  @HttpCode(200)
  deliver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmDeliveryDto,
    @CurrentStaffUser() staffUser: JwtPayload,
  ) {
    return this.drivers.deliver(id, staffUser, dto.cashCollected);
  }
}
