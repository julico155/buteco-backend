import { Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ProductImageStorage, PutObjectInput } from './product-image-storage';

/**
 * MVP sin S3/R2 configurado todavía: guarda en disco local bajo un
 * directorio propio. Implementa la misma interfaz `ProductImageStorage` —
 * swap a S3/R2 real es una clase nueva + un cambio de provider en
 * ProductsModule, sin tocar la lógica de negocio.
 */
@Injectable()
export class LocalDiskProductImageStorage implements ProductImageStorage {
  private readonly baseDir = join(process.cwd(), 'storage', 'product-images');

  async putObject({ key, bytes }: PutObjectInput): Promise<void> {
    const filePath = join(this.baseDir, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
  }

  async getObject(key: string): Promise<Buffer> {
    return readFile(join(this.baseDir, key));
  }
}
