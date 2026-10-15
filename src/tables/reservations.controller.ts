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
  UseGuards,
} from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentStaffUser } from '../auth/current-staff-user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { ApiClient } from '../common/decorators/api-client.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { ServiceOrStaffAuthGuard } from '../common/guards/service-or-staff-auth.guard';
import { ValidationError } from '../common/exceptions/domain-exception';
import { ReservationStatus } from '../database/types';
import { ReservationsService } from './reservations.service';
import {
  CancelReservationDto,
  CreateReservationDto,
  MoveReservationDto,
  SeatReservationDto,
  UpdateReservationSettingsDto,
} from './dto/reservation.dto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES: ReservationStatus[] = [
  'pending_payment',
  'confirmed',
  'seated',
  'cancelled',
  'no_show',
  'expired',
];

/**
 * Reservas. Lo público (disponibilidad, reservar, ver estado y cancelar) lo
 * usa la landing con el token de servicio; el cliente nunca ve qué mesa le
 * tocó. Lo operativo (listar, sentar, no se presentó, devolver) es del staff.
 */
@Controller()
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  // ---- Landing ----

  @Get('reservations/availability')
  @UseGuards(ServiceOrStaffAuthGuard)
  @ApiQuery({ name: 'date', required: true, type: String })
  @ApiQuery({ name: 'party', required: true, type: Number })
  availability(@Query('date') date?: string, @Query('party') party?: string) {
    if (!date || !DATE_RE.test(date)) {
      throw new ValidationError('date es obligatoria con formato YYYY-MM-DD.');
    }
    const partySize = Number(party);
    if (!Number.isInteger(partySize) || partySize < 1) {
      throw new ValidationError('party debe ser un entero mayor a 0.');
    }
    return this.reservations.availability(date, partySize);
  }

  @Post('reservations')
  @UseGuards(ServiceOrStaffAuthGuard)
  async create(
    @Body() dto: CreateReservationDto,
    @IdempotencyKey() idempotencyKey: string,
    @ApiClient() apiClient: string,
  ) {
    const outcome = await this.reservations.create(dto, idempotencyKey, apiClient, apiClient);
    return outcome.body;
  }

  @Get('reservations/:id')
  @UseGuards(ServiceOrStaffAuthGuard)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.getPublic(id);
  }

  @Post('reservations/:id/cancel')
  @UseGuards(ServiceOrStaffAuthGuard)
  @HttpCode(200)
  cancelPublic(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelReservationDto,
    @ApiClient() apiClient: string,
  ) {
    // Quien cancela desde la landing no puede forzar la devolución.
    return this.reservations.cancel(id, { reason: dto.reason, actor: apiClient });
  }

  // ---- Local (staff) ----

  @Get('reservations')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  @ApiQuery({ name: 'date', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String })
  list(@Query('date') date?: string, @Query('status') status?: string) {
    if (date !== undefined && !DATE_RE.test(date)) {
      throw new ValidationError('date debe tener formato YYYY-MM-DD.');
    }
    if (status !== undefined && !STATUSES.includes(status as ReservationStatus)) {
      throw new ValidationError('status no es válido.');
    }
    return this.reservations.list({ date, status: status as ReservationStatus | undefined });
  }

  @Get('reservations/:id/detail')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.getStaff(id);
  }

  @Post('reservations/:id/staff-cancel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  @HttpCode(200)
  cancelStaff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelReservationDto,
    @CurrentStaffUser() staffUser: JwtPayload,
  ) {
    return this.reservations.cancel(id, {
      reason: dto.reason,
      refund: dto.refund,
      actor: staffUser.username,
    });
  }

  @Post('reservations/:id/seat')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  @HttpCode(200)
  seat(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SeatReservationDto,
    @CurrentStaffUser() staffUser: JwtPayload,
  ) {
    return this.reservations.seat(id, { tableId: dto.tableId, staffUsername: staffUser.username });
  }

  @Post('reservations/:id/no-show')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  @HttpCode(200)
  noShow(@Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.markNoShow(id);
  }

  @Post('reservations/:id/refunded')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  @HttpCode(200)
  refunded(@Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.markRefunded(id);
  }

  @Patch('reservations/:id/table')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  move(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveReservationDto) {
    return this.reservations.move(id, dto.tableId);
  }

  // ---- Configuración ----

  @Get('reservation-settings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  getSettings() {
    return this.reservations.getSettings();
  }

  @Patch('reservation-settings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  updateSettings(@Body() dto: UpdateReservationSettingsDto) {
    return this.reservations.updateSettings(dto);
  }
}
