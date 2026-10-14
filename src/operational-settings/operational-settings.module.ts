import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { OperationalSettingsController } from './operational-settings.controller';
import { OperationalSettingsService } from './operational-settings.service';

@Module({
  imports: [CommonModule, AuthModule],
  controllers: [OperationalSettingsController],
  providers: [OperationalSettingsService],
  exports: [OperationalSettingsService],
})
export class OperationalSettingsModule {}
