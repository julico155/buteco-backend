import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { DeliveryTariffService, TariffBandResponse } from './delivery-tariff.service';
import { ReplaceTariffBandsDto } from './dto/replace-tariff-bands.dto';

/**
 * Bandas de tarifa por distancia, editables por el admin (antes solo por SQL).
 * Es un controller aparte: `DeliveryController` es solo de token de servicio.
 */
@Controller('delivery/tariff-bands')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class DeliveryBandsController {
  constructor(private readonly tariff: DeliveryTariffService) {}

  @Get()
  list(): Promise<TariffBandResponse[]> {
    return this.tariff.listBands();
  }

  /** Reemplaza la tabla completa, en una transacción. Rige para las próximas cotizaciones. */
  @Put()
  replace(@Body() dto: ReplaceTariffBandsDto): Promise<TariffBandResponse[]> {
    return this.tariff.replaceBands(dto.bands);
  }
}
