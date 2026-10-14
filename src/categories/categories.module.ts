import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

@Module({
  imports: [CommonModule, AuthModule],
  controllers: [CategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
