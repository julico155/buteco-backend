import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentStaffUser } from '../auth/current-staff-user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { TablesService } from './tables.service';
import { TableAccountsService } from './table-accounts.service';
import { CreateFloorDto, UpdateFloorDto } from './dto/floor.dto';
import { CreateTableDto, SaveLayoutDto, UpdateTableDto } from './dto/table.dto';
import { AddRoundDto, CloseAccountDto, OpenAccountDto, VoidLineDto } from './dto/account.dto';

/**
 * Plano del local y cuentas de mesa. Todo con JWT de staff: es una acción
 * presencial del cajero (queda registrado quién movió cada cuenta). El plano
 * (crear/mover/borrar) es solo del admin.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class TablesController {
  constructor(
    private readonly tables: TablesService,
    private readonly accounts: TableAccountsService,
  ) {}

  // ---- Ambientes ----

  @Get('floors')
  @Roles('admin', 'cashier')
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  listFloors(@Query('includeInactive') includeInactive?: string) {
    return this.tables.listFloors(includeInactive === 'true');
  }

  @Post('floors')
  @Roles('admin')
  createFloor(@Body() dto: CreateFloorDto) {
    return this.tables.createFloor(dto);
  }

  @Patch('floors/:id')
  @Roles('admin')
  updateFloor(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFloorDto) {
    return this.tables.updateFloor(id, dto);
  }

  @Delete('floors/:id')
  @Roles('admin')
  @HttpCode(204)
  deleteFloor(@Param('id', ParseUUIDPipe) id: string) {
    return this.tables.deleteFloor(id);
  }

  // ---- Mesas (plano) ----

  // Con el estado de cada mesa y el resumen de su cuenta: es lo que pinta el POS.
  @Get('tables')
  @Roles('admin', 'cashier')
  @ApiQuery({ name: 'floor_id', required: false, type: String })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  listTables(
    @Query('floor_id', new ParseUUIDPipe({ optional: true })) floorId?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.tables.listTables({ floorId, includeInactive: includeInactive === 'true' });
  }

  @Post('tables')
  @Roles('admin')
  createTable(@Body() dto: CreateTableDto) {
    return this.tables.createTable(dto);
  }

  // Antes de `tables/:id` para que "layout" no se interprete como un id.
  @Put('tables/layout')
  @Roles('admin')
  saveLayout(@Body() dto: SaveLayoutDto) {
    return this.tables.saveLayout(dto);
  }

  @Get('tables/:id')
  @Roles('admin', 'cashier')
  findTable(@Param('id', ParseUUIDPipe) id: string) {
    return this.tables.findTable(id);
  }

  @Patch('tables/:id')
  @Roles('admin')
  updateTable(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTableDto) {
    return this.tables.updateTable(id, dto);
  }

  @Delete('tables/:id')
  @Roles('admin')
  @HttpCode(204)
  deleteTable(@Param('id', ParseUUIDPipe) id: string) {
    return this.tables.deleteTable(id);
  }

  // ---- Cuenta de la mesa ----

  @Get('tables/:id/account')
  @Roles('admin', 'cashier')
  getAccount(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.getAccount(id);
  }

  @Post('tables/:id/account')
  @Roles('admin', 'cashier')
  openAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OpenAccountDto,
    @CurrentStaffUser() staffUser: JwtPayload,
  ) {
    return this.accounts.open(id, dto, staffUser.username);
  }

  @Post('tables/:id/account/rounds')
  @Roles('admin', 'cashier')
  async addRound(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddRoundDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentStaffUser() staffUser: JwtPayload,
  ) {
    const outcome = await this.accounts.addRound(id, dto, idempotencyKey, staffUser.username);
    return outcome.body;
  }

  // Anular no borra: la línea queda marcada (quién y por qué) y deja de sumar.
  @Post('tables/:id/account/items/:itemId/void')
  @Roles('admin', 'cashier')
  @HttpCode(200)
  voidItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: VoidLineDto,
    @CurrentStaffUser() staffUser: JwtPayload,
  ) {
    return this.accounts.voidLine(id, 'item', itemId, dto.reason, staffUser.username);
  }

  @Post('tables/:id/account/promotions/:promotionId/void')
  @Roles('admin', 'cashier')
  @HttpCode(200)
  voidPromotion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('promotionId', ParseUUIDPipe) promotionId: string,
    @Body() dto: VoidLineDto,
    @CurrentStaffUser() staffUser: JwtPayload,
  ) {
    return this.accounts.voidLine(id, 'promotion', promotionId, dto.reason, staffUser.username);
  }

  @Post('tables/:id/account/bill-request')
  @Roles('admin', 'cashier')
  @HttpCode(200)
  requestBill(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.requestBill(id);
  }

  @Post('tables/:id/account/close')
  @Roles('admin', 'cashier')
  @HttpCode(200)
  closeAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseAccountDto,
    @CurrentStaffUser() staffUser: JwtPayload,
  ) {
    return this.accounts.close(id, dto, staffUser.username);
  }

  @Post('tables/:id/account/reopen')
  @Roles('admin', 'cashier')
  @HttpCode(200)
  reopenAccount(@Param('id', ParseUUIDPipe) id: string, @CurrentStaffUser() staffUser: JwtPayload) {
    return this.accounts.reopen(id, staffUser.username);
  }

  @Post('tables/:id/account/cancel')
  @Roles('admin', 'cashier')
  @HttpCode(204)
  cancelAccount(@Param('id', ParseUUIDPipe) id: string, @CurrentStaffUser() staffUser: JwtPayload) {
    return this.accounts.cancel(id, staffUser.username);
  }
}
