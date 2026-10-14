import { Module } from '@nestjs/common';
import { BanecoClientService } from './baneco-client.service';

@Module({
  providers: [BanecoClientService],
  exports: [BanecoClientService],
})
export class BanecoModule {}
