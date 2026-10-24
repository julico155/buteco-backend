import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentStaffUser } from '../auth/current-staff-user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { BillingService } from './billing.service';
import { CreateAdjustmentDto } from './dto/create-adjustment.dto';
import { CreateTopupDto } from './dto/create-topup.dto';

/**
 * Saldo prepago del negocio y comisión del agente. Todo es del personal (JWT): el saldo es plata del local, no algo que deba
 * ver el agente ni el cliente.
 */
@Controller('billing')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Saldo, lo comprometido en pedidos abiertos, y los avisos (`lowBalance`, `suspended`) que pinta el POS. */
  @Get('balance')
  @Roles('admin', 'cashier')
  balance() {
    return this.billing.getSummary();
  }

  /** Libro de movimientos, el más reciente primero. */
  @Get('ledger')
  @Roles('admin', 'cashier')
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  ledger(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.billing.listLedger(limit ? Number(limit) : undefined, offset ? Number(offset) : undefined);
  }

  /** Genera el QR para recargar saldo. Mínimo `AGENT_TOPUP_MIN_AMOUNT` (Bs 10 por defecto). */
  @Post('topups')
  @Roles('admin', 'cashier')
  createTopup(@Body() dto: CreateTopupDto, @CurrentStaffUser() staffUser: JwtPayload) {
    return this.billing.createTopup(dto.amount, staffUser.username);
  }

  /** Estado de una recarga: el POS la consulta hasta que pase a `confirmed`. */
  @Get('topups/:id')
  @Roles('admin', 'cashier')
  topup(@Param('id', ParseUUIDPipe) id: string) {
    return this.billing.getTopup(id);
  }

  @Get('topups/:id/qr-image')
  @Roles('admin', 'cashier')
  @ApiProduces('image/png')
  @ApiOkResponse({
    description: 'La imagen del QR.',
    content: { 'image/*': { schema: { type: 'string', format: 'binary' } } },
  })
  async topupImage(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { bytes, mimeType } = await this.billing.getTopupImage(id);
    res.setHeader('content-type', mimeType);
    res.setHeader('cache-control', 'private, max-age=60');
    res.send(bytes);
  }

  /** Corrección manual del saldo, con motivo. Solo admin. */
  @Post('adjustments')
  @Roles('admin')
  adjust(@Body() dto: CreateAdjustmentDto, @CurrentStaffUser() staffUser: JwtPayload) {
    return this.billing.createAdjustment(dto.amount, dto.note, staffUser.username);
  }
}
