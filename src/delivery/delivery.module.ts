import { forwardRef, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { OperationalSettingsModule } from '../operational-settings/operational-settings.module';
import { OrdersModule } from '../orders/orders.module';
import { DeliveryController } from './delivery.controller';
import { DeliveryBandsController } from './delivery-bands.controller';
import { DeliveryManualQuoteController } from './delivery-manual-quote.controller';
import { DeliveryService } from './delivery.service';
import { DeliveryTariffService } from './delivery-tariff.service';
import { DISTANCE_SERVICE, DistanceService, HaversineDistanceService } from './distance/distance.service';
import { MapboxDistanceService } from './distance/mapbox-distance.service';

@Module({
  // forwardRef: OrdersModule ya importa DeliveryModule (OrdersService cotiza
  // dentro de su propia transacción vía quoteForOrderInTransaction); acá es
  // solo para que el controller dispare el QR tras cotizar por este otro
  // camino (quote/quote-manual), sin duplicar la lógica de envío.
  imports: [CommonModule, AuthModule, OperationalSettingsModule, forwardRef(() => OrdersModule)],
  controllers: [DeliveryController, DeliveryBandsController, DeliveryManualQuoteController],
  providers: [
    DeliveryService,
    DeliveryTariffService,
    {
      provide: DISTANCE_SERVICE,
      useFactory: (config: ConfigService<AppConfig, true>): DistanceService => {
        const { accessToken } = config.get('mapbox', { infer: true });
        return accessToken ? new MapboxDistanceService(accessToken) : new HaversineDistanceService();
      },
      inject: [ConfigService],
    },
  ],
  exports: [DeliveryService, DeliveryTariffService],
})
export class DeliveryModule {}
