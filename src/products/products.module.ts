import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { LocalDiskProductImageStorage } from './storage/local-disk-product-image-storage';
import { S3ProductImageStorage } from './storage/s3-product-image-storage';
import { PRODUCT_IMAGE_STORAGE, ProductImageStorage } from './storage/product-image-storage';

@Module({
  imports: [CommonModule, AuthModule],
  controllers: [ProductsController],
  providers: [
    ProductsService,
    {
      // Config `s3` genérica (STORAGE_S3_*): se activa solo si hay S3/R2
      // configurado; sin credenciales cae a disco local.
      provide: PRODUCT_IMAGE_STORAGE,
      useFactory: (config: ConfigService<AppConfig, true>): ProductImageStorage => {
        const s3 = config.get('s3', { infer: true });
        if (s3.bucket && s3.accessKeyId && s3.secretAccessKey) {
          return new S3ProductImageStorage({
            bucket: s3.bucket,
            region: s3.region,
            accessKeyId: s3.accessKeyId,
            secretAccessKey: s3.secretAccessKey,
            endpoint: s3.endpoint || undefined,
          });
        }
        return new LocalDiskProductImageStorage();
      },
      inject: [ConfigService],
    },
  ],
  exports: [ProductsService],
})
export class ProductsModule {}
