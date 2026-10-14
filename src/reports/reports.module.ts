import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [CommonModule, AuthModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
