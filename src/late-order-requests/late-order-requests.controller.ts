import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { ApiClient } from '../common/decorators/api-client.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentStaffUser } from '../auth/current-staff-user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { ApiQuery } from '@nestjs/swagger';
import { LateOrderRequestStatus } from '../database/types';
import { LateOrderRequestsService } from './late-order-requests.service';
import { RejectLateOrderRequestDto } from './dto/reject-late-order-request.dto';

@Controller('late-order-requests')
export class LateOrderRequestsController {
  constructor(private readonly lateOrderRequests: LateOrderRequestsService) {}

  /**
   * M7A: estado definitivo de la solicitud (el 202 de `POST /orders`) por la `Idempotency-Key` con la que se creó.
   * Solo servicio: busca dentro de las solicitudes de ESE servicio y exige el `phone` del cliente dueño; cualquier otro caso
   * es 404. No devuelve nombre ni carrito, solo el estado (y el pedido, si fue aceptada).
   */
  @Get('by-key/:idempotencyKey')
  @UseGuards(ServiceAuthGuard)
  @ApiQuery({ name: 'phone', required: true, type: String })
  findByKey(
    @Param('idempotencyKey') idempotencyKey: string,
    @Query('phone') phone: string | undefined,
    @ApiClient() apiClient: string,
  ) {
    return this.lateOrderRequests.findByKey(apiClient, idempotencyKey, phone);
  }

  /** Cola para el dashboard — por defecto solo 'pending'. Solo staff: trae nombre y datos del cliente. */
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  findMany(
    @Query('status') status?: LateOrderRequestStatus,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.lateOrderRequests.findMany({
      status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  /** Solo staff: antes lo leía cualquier servicio conociendo el UUID. Los servicios usan `by-key`. */
  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.lateOrderRequests.findById(id);
  }

  // decidedBy es ahora el staff autenticado (JWT), no el api_client de
  // servicio — la aceptación/rechazo es una decisión humana, no del gateway.
  @Post(':id/accept')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  accept(@Param('id', ParseUUIDPipe) id: string, @CurrentStaffUser() staffUser: JwtPayload) {
    return this.lateOrderRequests.accept(id, staffUser.username);
  }

  @Post(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentStaffUser() staffUser: JwtPayload,
    @Body() dto: RejectLateOrderRequestDto,
  ) {
    return this.lateOrderRequests.reject(id, staffUser.username, dto.reason);
  }
}
