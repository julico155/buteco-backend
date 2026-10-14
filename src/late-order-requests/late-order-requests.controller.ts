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
import { ServiceOrStaffAuthGuard } from '../common/guards/service-or-staff-auth.guard';
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

  /** Cola para el dashboard — por defecto solo 'pending'. */
  @Get()
  @UseGuards(ServiceOrStaffAuthGuard)
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

  @Get(':id')
  @UseGuards(ServiceOrStaffAuthGuard)
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
