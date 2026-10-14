import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { OrdersModule } from '../orders/orders.module';
import { AgentLocationsController } from './agent-locations.controller';
import { AgentLocationsService } from './agent-locations.service';

@Module({
  imports: [CommonModule, OrdersModule],
  controllers: [AgentLocationsController],
  providers: [AgentLocationsService],
})
export class AgentLocationsModule {}
