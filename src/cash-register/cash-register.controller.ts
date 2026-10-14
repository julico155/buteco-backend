import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentStaffUser } from '../auth/current-staff-user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { CashRegisterService } from './cash-register.service';
import { OpenCashRegisterDto } from './dto/open-cash-register.dto';
import { CloseCashRegisterDto } from './dto/close-cash-register.dto';

@Controller('cash-register/sessions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CashRegisterController {
  constructor(private readonly cashRegister: CashRegisterService) {}

  @Post('open')
  @Roles('admin', 'cashier')
  open(@Body() dto: OpenCashRegisterDto, @CurrentStaffUser() staffUser: JwtPayload) {
    return this.cashRegister.open(dto.openingAmount, staffUser.username);
  }

  @Post('close')
  @Roles('admin', 'cashier')
  close(@Body() dto: CloseCashRegisterDto, @CurrentStaffUser() staffUser: JwtPayload) {
    return this.cashRegister.close(dto.countedCashAmount, dto.notes, staffUser.username);
  }

  /** Cualquier rol de staff excepto delivery puede consultar si hay caja abierta (ej. para habilitar el cobro en el POS). */
  @Get('current')
  @Roles('admin', 'cashier', 'kitchen')
  getCurrent() {
    return this.cashRegister.getCurrent();
  }

  @Get()
  @Roles('admin', 'cashier')
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  findMany(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.cashRegister.findMany(limit ? Number(limit) : undefined, offset ? Number(offset) : undefined);
  }

  @Get(':id')
  @Roles('admin', 'cashier')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.cashRegister.getById(id);
  }
}
