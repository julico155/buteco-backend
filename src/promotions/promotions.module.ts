import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';

@Module({
  imports: [CommonModule, AuthModule],
  controllers: [PromotionsController],
  providers: [PromotionsService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
