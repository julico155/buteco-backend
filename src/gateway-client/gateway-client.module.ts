import { Module } from '@nestjs/common';
import { GatewayClientService } from './gateway-client.service';

@Module({
  providers: [GatewayClientService],
  exports: [GatewayClientService],
})
export class GatewayClientModule {}
